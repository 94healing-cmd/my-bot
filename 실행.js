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
const express = require('express');

// ==========================================
// [1] 기본 설정
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = '1504881356021170226';
const ATTENDANCE_CHANNEL_ID = '1445449644678320198';
const TTS_CHANNEL_ID = '1505249610632007861';
const MANAGER_ROLE_ID = '1445443506175873164';

const DB_FILE = './attendance.json';
const REWARD_FILE = './rewards.json';
const STICKY_FILE = './sticky.json';

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
// [2] 유틸리티 (데이터 저장/로드) - 영구 보존용
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
        console.error(`[오류] ${file} 읽기 실패. 백업본 확인 필요.`);
        return {};
    }
};

const saveDB = (file, data) => {
    try {
        // 저장 직전 백업 생성 (업데이트 중 파일 깨짐 방지)
        if (fs.existsSync(file)) {
            fs.copyFileSync(file, file + '.bak');
        }
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
    new SlashCommandBuilder().setName('출석순위').setDescription('출석 랭킹 TOP 15를 확인합니다.'),
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
    console.log(`✅ ${client.user.tag} 온라인! 데이터 로드 완료.`);
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ 슬래시 명령어 동기화 완료');
    } catch (e) { console.error(e); }
});

// ==========================================
// [5] 메시지 핸들러 (!출석순위 등)
// ==========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // --- 1. 출석체크 (!출석) ---
    if (message.content === '!출석' && message.channelId === ATTENDANCE_CHANNEL_ID) {
        const db = loadDB(DB_FILE);
        const today = getTodayInfo();
        const userData = getUserDB(db, message.author.id);

        if (userData.lastDate === today.dateString) {
            return message.reply('✅ 이미 오늘 출석을 완료했습니다!');
        }

        userData.count += 1;
        userData.lastDate = today.dateString;
        saveDB(DB_FILE, db); // 즉시 저장

        let replyMsg = `✅ **${message.member.displayName}**님, 출석 완료! (총 **${userData.count}회**)`;
        const upgraded = await updateRoles(message.member, userData.count);
        if (upgraded) replyMsg += `\n🎉 **새로운 등급 역할을 획득했습니다!**`;
        return message.reply(replyMsg);
    }

    // --- 2. 랭킹 조회 (!출석순위) : 모든 유저 사용 가능 ---
    if (message.content === '!출석순위') {
        const db = loadDB(DB_FILE);
        const ranking = Object.entries(db)
            .map(([id, data]) => ({ id, count: data.count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 15);

        if (ranking.length === 0) return message.reply('❌ 등록된 출석 데이터가 없습니다.');

        const rankList = ranking.map((u, i) => `**${i + 1}위** | <@${u.id}> - **${u.count}회**`).join('\n');
        const rankEmbed = new EmbedBuilder()
            .setTitle('🏆 전체 출석 랭킹 TOP 15')
            .setDescription(rankList)
            .setColor('#f1c40f')
            .setFooter({ text: '매일 !출석으로 순위를 높여보세요!' });

        return message.reply({ embeds: [rankEmbed] });
    }

    // --- 3. TTS 기능 ---
    if (message.channelId === TTS_CHANNEL_ID) {
        if (message.content === '!입장') {
            const vc = message.member.voice.channel;
            if (!vc) return message.reply('❌ 음성 채널에 먼저 접속해주세요.');
            currentConnection = joinVoiceChannel({ channelId: vc.id, guildId: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator });
            currentConnection.subscribe(audioPlayer);
            return message.reply('🎙️ TTS를 시작합니다. 채팅을 읽어드릴게요.');
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

    // --- 4. 고정 공지 유지 ---
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
// [6] 인터랙션 핸들러 (슬래시 & 모달)
// ==========================================
client.on('interactionCreate', async (interaction) => {
    // 고정공지 모달 제출
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

    // 순위 확인 (/출석순위) : 누구나 가능
    if (interaction.commandName === '출석순위') {
        const db = loadDB(DB_FILE);
        const ranking = Object.entries(db).map(([id, d]) => ({ id, count: d.count })).sort((a, b) => b.count - a.count).slice(0, 15);
        let desc = ranking.length ? ranking.map((u, i) => `**${i + 1}위** | <@${u.id}> : ${u.count}회`).join('\n') : '데이터가 없습니다.';
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🏆 출석 랭킹').setDescription(desc).setColor('#f1c40f')] });
    }

    // 관리자 체크
    const isManager = interaction.member.roles.cache.has(MANAGER_ROLE_ID) || interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    if (!isManager) return interaction.reply({ content: '❌ 관리자 전용 권한입니다.', ephemeral: true });

    if (interaction.commandName === '출석조절') {
        const user = interaction.options.getUser('대상');
        const count = interaction.options.getInteger('횟수');
        const db = loadDB(DB_FILE);
        const userData = getUserDB(db, user.id);
        userData.count = count;
        saveDB(DB_FILE, db);
        const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (targetMember) await updateRoles(targetMember, count);
        return interaction.reply(`🔧 <@${user.id}>님의 횟수를 **${count}회**로 변경했습니다.`);
    }

    if (interaction.commandName === '보상설정') {
        const count = interaction.options.getInteger('목표횟수');
        const role = interaction.options.getRole('지급역할');
        const rdb = loadDB(REWARD_FILE);
        rdb[count] = role.id;
        saveDB(REWARD_FILE, rdb);
        return interaction.reply(`✅ **${count}회** 달성 시 <@&${role.id}> 역할이 자동 지급됩니다.`);
    }

    if (interaction.commandName === '고정공지') {
        const modal = new ModalBuilder().setCustomId('stickyModal').setTitle('고정 공지 설정');
        const input = new TextInputBuilder().setCustomId('stickyContent').setLabel('내용 (줄바꿈 가능)').setStyle(TextInputStyle.Paragraph).setRequired(true);
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

// 웹 서버 (Uptime 유지용)
const app = express();
app.get('/', (req, res) => res.send('Bot is Running!'));
app.listen(process.env.PORT || 3000);

client.login(TOKEN);