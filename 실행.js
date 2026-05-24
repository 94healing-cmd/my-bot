const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder
} = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@discordjs/voice');
const googleTTS = require('google-tts-api');
const fs = require('fs');
const path = require('path'); // 안전한 파일 경로 설정을 위해 추가
const express = require('express');

// ==========================================
// [1] 기본 설정
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = '1504881356021170226';
const ATTENDANCE_CHANNEL_ID = '1445449644678320198';
const TTS_CHANNEL_ID = '1505249610632007861';
const MANAGER_ROLE_ID = '1445443506175873164';

// 로컬 파일 경로를 절대 경로로 고정하여 경로 꼬임 방지
const DB_FILE = path.join(__dirname, 'attendance.json');
const REWARD_FILE = path.join(__dirname, 'rewards.json');
const STICKY_FILE = path.join(__dirname, 'sticky.json');

const stickyMessages = new Map();
const isStickyUpdating = new Set();
let currentConnection = null;
const audioPlayer = createAudioPlayer();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// ==========================================
// [2] 유틸리티 (데이터 저장/로드)
// ==========================================
const loadDB = (file) => {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify({}, null, 2));
        return {};
    }
    try {
        const data = fs.readFileSync(file, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        console.error(`[오류] ${file} 읽기 실패.`);
        return {};
    }
};

const saveDB = (file, data) => {
    try {
        if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`[오류] ${file} 저장 실패:`, e);
    }
};

const getUserDB = (db, userId) => {
    if (!db[userId]) db[userId] = { count: 0, lastDate: '' };
    return db[userId];
};

const getTodayInfo = () => {
    const now = new Date();
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    return {
        dateString: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
        dayName: `${days[now.getDay()]}요일`
    };
};

// 랭킹 문자열 생성 함수 (중복 제거 및 최적화)
function generateRankingList(db, limit = 100) {
    const sorted = Object.entries(db)
        .map(([id, data]) => ({ id, count: data.count }))
        .filter(u => u.count > 0)
        .sort((a, b) => b.count - a.count);

    if (sorted.length === 0) return "출석 데이터가 없습니다.";

    let list = "";
    for (let i = 0; i < Math.min(sorted.length, limit); i++) {
        const line = `**${i + 1}위** | <@${sorted[i].id}> - **${sorted[i].count}회**\n`;
        if ((list + line).length > 3900) {
            list += "...하위 순위 생략";
            break;
        }
        list += line;
    }
    return list;
}

async function updateRoles(member, currentCount) {
    const rewards = loadDB(REWARD_FILE);
    let targetRoleId = null;
    let maxReq = -1;

    for (const [reqCount, roleId] of Object.entries(rewards)) {
        const req = parseInt(reqCount);
        if (currentCount >= req && req > maxReq) {
            maxReq = req;
            targetRoleId = roleId;
        }
    }

    if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
        try {
            const allRewardRoles = Object.values(rewards);
            await member.roles.remove(allRewardRoles).catch(() => {});
            await member.roles.add(targetRoleId);
            return true;
        } catch (error) { console.error('역할 변경 실패:', error); }
    }
    return false;
}

// ==========================================
// [3] 명령어 구성
// ==========================================
const commands = [
    new SlashCommandBuilder().setName('출석순위').setDescription('출석 랭킹 TOP 100를 확인합니다.'),
    new SlashCommandBuilder().setName('출석조절').setDescription('유저의 출석 횟수를 변경 (관리자)')
        .addUserOption(o => o.setName('대상').setDescription('대상 유저').setRequired(true))
        .addIntegerOption(o => o.setName('횟수').setDescription('변경할 횟수').setRequired(true)),
    new SlashCommandBuilder().setName('보상설정').setDescription('출석 달성 보상 역할 설정 (관리자)')
        .addIntegerOption(o => o.setName('목표횟수').setDescription('필요 횟수').setRequired(true))
        .addRoleOption(o => o.setName('지급역할').setDescription('지급할 역할').setRequired(true)),
    new SlashCommandBuilder().setName('고정공지').setDescription('채널 하단 고정 공지 설정 (관리자)'),
    new SlashCommandBuilder().setName('공지해지').setDescription('고정 공지 해제 (관리자)')
].map(c => c.toJSON());

// ==========================================
// [4] 봇 준비
// ==========================================
client.once('ready', async () => {
    console.log(`✅ ${client.user.tag} 온라인!`);
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ 슬래시 명령어 동기화 완료');
    } catch (e) { console.error(e); }
});

// ==========================================
// [5] 메시지 핸들러
// ==========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // !출석
    if (message.content === '!출석' && message.channelId === ATTENDANCE_CHANNEL_ID) {
        const db = loadDB(DB_FILE);
        const today = getTodayInfo();
        const userData = getUserDB(db, message.author.id);

        if (userData.lastDate === today.dateString) {
            return message.reply('✅ 이미 오늘 출석을 완료했습니다!');
        }

        userData.count += 1;
        userData.lastDate = today.dateString;
        saveDB(DB_FILE, db);

        let replyMsg = `✅ **${message.member.displayName}**님, 출석 완료! (총 **${userData.count}회**)`;
        const upgraded = await updateRoles(message.member, userData.count);
        if (upgraded) replyMsg += `\n🎉 **새로운 등급 역할을 획득했습니다!**`;
        return message.reply(replyMsg);
    }

    // !출석순위
    if (message.content === '!출석순위') {
        const db = loadDB(DB_FILE);
        const rankList = generateRankingList(db, 100);

        const rankEmbed = new EmbedBuilder()
            .setTitle('🏆 전체 출석 랭킹')
            .setDescription(rankList)
            .setColor('#f1c40f')
            .setTimestamp()
            .setFooter({ text: '관리자가 조정한 데이터가 실시간 반영됩니다.' });

        return message.reply({ embeds: [rankEmbed] });
    }

    // TTS & 고정공지
    if (message.channelId === TTS_CHANNEL_ID) {
        if (message.content === '!입장') {
            const vc = message.member.voice.channel;
            if (!vc) return message.reply('❌ 음성 채널에 먼저 접속해주세요.');
            currentConnection = joinVoiceChannel({ channelId: vc.id, guildId: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator });
            currentConnection.subscribe(audioPlayer);
            return message.reply('🎙️ TTS를 시작합니다.');
        }
        if (message.content === '!퇴장' && currentConnection) {
            currentConnection.destroy();
            currentConnection = null;
            return message.reply('👋 퇴장합니다.');
        }
        if (!message.content.startsWith('!') && currentConnection) {
            const url = googleTTS.getAudioUrl(message.content.substring(0, 200), { lang: 'ko', slow: false, host: 'https://translate.google.com' });
            audioPlayer.play(createAudioResource(url));
        }
    }

    if (stickyMessages.has(message.channelId) && !isStickyUpdating.has(message.channelId)) {
        isStickyUpdating.add(message.channelId);
        try {
            const data = stickyMessages.get(message.channelId);
            if (data.lastMessageId) {
                const old = await message.channel.messages.fetch(data.lastMessageId).catch(() => null);
                if (old) await old.delete().catch(() => {});
            }
            const stickyEmbed = new EmbedBuilder().setTitle('📌 [ 공지 ]').setDescription(data.content).setColor('#ff9839');
            const newMsg = await message.channel.send({ embeds: [stickyEmbed] });
            data.lastMessageId = newMsg.id;
            stickyMessages.set(message.channelId, data);
            const sdb = loadDB(STICKY_FILE);
            sdb[message.channelId] = data;
            saveDB(STICKY_FILE, sdb);
        } finally { isStickyUpdating.delete(message.channelId); }
    }
});

// ==========================================
// [6] 인터랙션 핸들러
// ==========================================
client.on('interactionCreate', async (interaction) => {
    if (interaction.isModalSubmit() && interaction.customId === 'stickyModal') {
        const content = interaction.fields.getTextInputValue('stickyContent');
        const newMsg = await interaction.channel.send({ embeds: [new EmbedBuilder().setTitle('📌 [ 공지 ]').setDescription(content).setColor('#ff9839')] });
        const newData = { content, lastMessageId: newMsg.id };
        stickyMessages.set(interaction.channelId, newData);
        const sdb = loadDB(STICKY_FILE);
        sdb[interaction.channelId] = newData;
        saveDB(STICKY_FILE, sdb);
        return interaction.reply({ content: '✅ 고정 공지가 설정되었습니다.', ephemeral: true });
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === '출석순위') {
        const db = loadDB(DB_FILE);
        const rankList = generateRankingList(db, 100);
        return interaction.reply({ 
            embeds: [new EmbedBuilder().setTitle('🏆 전체 출석 랭킹').setDescription(rankList).setColor('#f1c40f')] 
        });
    }

    const isManager = interaction.member.roles.cache.has(MANAGER_ROLE_ID) || interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    if (!isManager) return interaction.reply({ content: '❌ 권한이 없습니다.', ephemeral: true });

    if (interaction.commandName === '출석조절') {
        const user = interaction.options.getUser('대상');
        const count = interaction.options.getInteger('횟수');
        const db = loadDB(DB_FILE);
        const userData = getUserDB(db, user.id);
        
        userData.count = count;
        saveDB(DB_FILE, db);
        
        const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (targetMember) await updateRoles(targetMember, count);
        
        return interaction.reply(`🔧 <@${user.id}>님의 횟수를 **${count}회**로 변경했습니다. 순위표에 즉시 반영됩니다.`);
    }

    if (interaction.commandName === '보상설정') {
        const count = interaction.options.getInteger('목표횟수');
        const role = interaction.options.getRole('지급역할');
        const rdb = loadDB(REWARD_FILE);
        rdb[count] = role.id;
        saveDB(REWARD_FILE, rdb);
        return interaction.reply(`✅ **${count}회** 달성 보상 설정 완료.`);
    }

    if (interaction.commandName === '고정공지') {
        const modal = new ModalBuilder().setCustomId('stickyModal').setTitle('고정 공지 설정');
        const input = new TextInputBuilder().setCustomId('stickyContent').setLabel('내용').setStyle(TextInputStyle.Paragraph).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
    }

    if (interaction.commandName === '공지해지') {
        stickyMessages.delete(interaction.channelId);
        const sdb = loadDB(STICKY_FILE);
        delete sdb[interaction.channelId];
        saveDB(STICKY_FILE, sdb);
        return interaction.reply('✅ 고정 공지가 해제되었습니다.');
    }
});

const app = express();
app.get('/', (req, res) => res.send('Bot is Running!'));
app.listen(process.env.PORT || 3000);

client.login(TOKEN);