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
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const googleTTS = require('google-tts-api');
const fs = require('fs');
const express = require('express');

// ==========================================
// [1] 기본 설정 및 클라이언트 초기화
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
        GatewayIntentBits.GuildVoiceStates // TTS 음성 채널용
    ]
});

// ==========================================
// [2] 유틸리티 함수 (DB 관리 등)
// ==========================================
const loadDB = (file) => {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({}));
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return {};
    }
};

const saveDB = (file, data) => {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); // 자동 백업
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
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

// 역할 자동 업데이트 로직
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
        } catch (error) {
            console.error('역할 변경 실패:', error);
        }
    }
    return false;
}

// 고정 메시지 관련 함수
async function deleteMessageSafe(channel, messageId) {
    if (!messageId) return;
    try {
        const oldMsg = await channel.messages.fetch(messageId);
        if (oldMsg) await oldMsg.delete();
    } catch (e) {}
}

async function sendStickyEmbed(channel, content) {
    const stickyEmbed = new EmbedBuilder()
        .setTitle('📌 [ 공지 ]')
        .setDescription(content)
        .setColor('#ff9839');
    return await channel.send({ embeds: [stickyEmbed] });
}

// ==========================================
// [3] 슬래시 명령어 등록 구성
// ==========================================
const commands = [
    new SlashCommandBuilder()
        .setName('출석조절')
        .setDescription('유저의 출석 횟수를 변경합니다. (관리자)')
        .addUserOption(opt => opt.setName('대상').setDescription('대상 유저').setRequired(true))
        .addIntegerOption(opt => opt.setName('횟수').setDescription('변경할 횟수').setRequired(true)),
    new SlashCommandBuilder()
        .setName('보상설정')
        .setDescription('출석 달성 보상 역할을 설정합니다. (관리자)')
        .addIntegerOption(opt => opt.setName('목표횟수').setDescription('필요 횟수').setRequired(true))
        .addRoleOption(opt => opt.setName('지급역할').setDescription('지급할 역할').setRequired(true)),
    new SlashCommandBuilder()
        .setName('고정공지')
        .setDescription('채널 하단 고정 공지를 설정합니다. (관리자)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('공지해지')
        .setDescription('고정 공지를 해제합니다. (관리자)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('출석순위')
        .setDescription('출석 랭킹 TOP 100을 확인합니다.')
].map(command => command.toJSON());

// ==========================================
// [4] 봇 실행 및 초기화
// ==========================================
client.once('ready', async () => {
    console.log(`✅ 로그인 완료: ${client.user.tag}`);
    
    // 고정 메시지 데이터 로드
    const savedStickies = loadDB(STICKY_FILE);
    for (const [chId, data] of Object.entries(savedStickies)) {
        stickyMessages.set(chId, data);
    }

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ 슬래시 명령어 등록 완료');
    } catch (error) {
        console.error('❌ 명령어 등록 실패:', error);
    }
});

// ==========================================
// [5] 메시지 이벤트 핸들러 (출석, TTS, 고정공지)
// ==========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // 1. 출석 체크 (!출석)
    if (message.content === '!출석' && message.channelId === ATTENDANCE_CHANNEL_ID) {
        const db = loadDB(DB_FILE);
        const today = getTodayInfo();
        const userData = getUserDB(db, message.author.id);

        if (userData.lastDate === today.dateString) {
            return message.reply('✅ 오늘은 이미 출석하셨습니다!');
        }

        userData.count += 1;
        userData.lastDate = today.dateString;
        saveDB(DB_FILE, db);

        let replyMsg = `✅ **${message.member.displayName}**님 출석 완료! (총 **${userData.count}회**)`;
        const upgraded = await updateRoles(message.member, userData.count);
        if (upgraded) replyMsg += `\n🎉 **역할 업그레이드 완료!**`;
        
        return message.reply(replyMsg);
    }

    // 2. TTS 제어 및 읽기
    if (message.channelId === TTS_CHANNEL_ID) {
        if (message.content === '!입장') {
            const voiceChannel = message.member.voice.channel;
            if (!voiceChannel) return message.reply('❌ 먼저 음성 채널에 들어가주세요!');
            currentConnection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
            });
            currentConnection.subscribe(audioPlayer);
            return message.reply('✅ TTS 서비스를 시작합니다.');
        }

        if (message.content === '!퇴장') {
            if (currentConnection) {
                currentConnection.destroy();
                currentConnection = null;
                return message.reply('👋 퇴장합니다.');
            }
        }

        // TTS 읽기 (명령어가 아닐 때)
        if (!message.content.startsWith('!') && currentConnection) {
            const text = message.content.substring(0, 200);
            const url = googleTTS.getAudioUrl(text, { lang: 'ko', slow: false, host: 'https://translate.google.com' });
            audioPlayer.play(createAudioResource(url));
        }
    }

    // 3. 고정 메시지 갱신 (채팅 발생 시 하단 이동)
    if (stickyMessages.has(message.channelId) && !isStickyUpdating.has(message.channelId)) {
        isStickyUpdating.add(message.channelId);
        try {
            const data = stickyMessages.get(message.channelId);
            await deleteMessageSafe(message.channel, data.lastMessageId);
            const newMsg = await sendStickyEmbed(message.channel, data.content);
            data.lastMessageId = newMsg.id;
            stickyMessages.set(message.channelId, data);
            
            // 파일 저장
            const db = loadDB(STICKY_FILE);
            db[message.channelId] = data;
            saveDB(STICKY_FILE, db);
        } finally {
            isStickyUpdating.delete(message.channelId);
        }
    }
});

// ==========================================
// [6] 인터랙션 처리 (슬래시 명령어 & 모달)
// ==========================================
client.on('interactionCreate', async (interaction) => {
    // 모달 제출 처리
    if (interaction.isModalSubmit() && interaction.customId === 'stickyModal') {
        const content = interaction.fields.getTextInputValue('stickyContent');
        const existing = stickyMessages.get(interaction.channelId);
        if (existing) await deleteMessageSafe(interaction.channel, existing.lastMessageId);

        const newMsg = await sendStickyEmbed(interaction.channel, content);
        const newData = { content, lastMessageId: newMsg.id };
        stickyMessages.set(interaction.channelId, newData);
        
        const db = loadDB(STICKY_FILE);
        db[interaction.channelId] = newData;
        saveDB(STICKY_FILE, db);

        return interaction.reply({ content: '✅ 고정 공지가 설정되었습니다.', ephemeral: true });
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, member, guild, channelId } = interaction;
    const isManager = member.roles.cache.has(MANAGER_ROLE_ID) || member.permissions.has(PermissionFlagsBits.Administrator);

    // 출석 순위 (모두 허용)
    if (commandName === '출석순위') {
        const db = loadDB(DB_FILE);
        const ranking = Object.entries(db)
            .map(([id, data]) => ({ id, count: data.count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 15); // 너무 길면 안되므로 15위까지

        if (ranking.length === 0) return interaction.reply('기록이 없습니다.');

        let desc = ranking.map((u, i) => `**${i + 1}위** | <@${u.id}> : ${u.count}회`).join('\n');
        const embed = new EmbedBuilder().setTitle('🏆 출석 랭킹 TOP 15').setDescription(desc).setColor('#f1c40f');
        return interaction.reply({ embeds: [embed] });
    }

    // 관리자 전용 명령어 체크
    if (!isManager) return interaction.reply({ content: '❌ 권한이 없습니다.', ephemeral: true });

    if (commandName === '출석조절') {
        const user = options.getUser('대상');
        const count = options.getInteger('횟수');
        const db = loadDB(DB_FILE);
        const userData = getUserDB(db, user.id);
        userData.count = count;
        saveDB(DB_FILE, db);
        
        const targetMember = await guild.members.fetch(user.id).catch(() => null);
        if (targetMember) await updateRoles(targetMember, count);
        return interaction.reply(`🔧 <@${user.id}>님의 출석 횟수를 **${count}회**로 조정했습니다.`);
    }

    if (commandName === '보상설정') {
        const count = options.getInteger('목표횟수');
        const role = options.getRole('지급역할');
        const rewards = loadDB(REWARD_FILE);
        rewards[count] = role.id;
        saveDB(REWARD_FILE, rewards);
        return interaction.reply(`✅ **${count}회** 달성 보상으로 <@&${role.id}> 역할을 설정했습니다.`);
    }

    if (commandName === '고정공지') {
        const modal = new ModalBuilder().setCustomId('stickyModal').setTitle('고정 공지 설정');
        const input = new TextInputBuilder()
            .setCustomId('stickyContent')
            .setLabel('내용을 입력하세요')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
    }

    if (commandName === '공지해지') {
        if (stickyMessages.has(channelId)) {
            const data = stickyMessages.get(channelId);
            await deleteMessageSafe(interaction.channel, data.lastMessageId);
            stickyMessages.delete(channelId);
            const db = loadDB(STICKY_FILE);
            delete db[channelId];
            saveDB(STICKY_FILE, db);
            return interaction.reply('✅ 고정 메시지를 해제했습니다.');
        }
        return interaction.reply('설정된 고정 메시지가 없습니다.');
    }
});

// ==========================================
// [7] 웹 서버 및 실행
// ==========================================
const app = express();
app.get('/', (req, res) => res.send('Bot is Online!'));
app.listen(process.env.PORT || 3000);

client.login(TOKEN);