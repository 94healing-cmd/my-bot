const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ModalBuilder,         // 🚀 [추가] 팝업창 생성용
    TextInputBuilder,     // 🚀 [추가] 팝업창 텍스트 입력칸
    TextInputStyle,       // 🚀 [추가] 텍스트 입력칸 스타일 (여러 줄)
    ActionRowBuilder      // 🚀 [추가] 컴포넌트 배치용
} = require('discord.js');
const fs = require('fs');
const express = require('express');

// ==========================================
// [1] 기본 설정
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = '1504881356021170226';
const ATTENDANCE_CHANNEL_ID = '1445449644678320198';
const MANAGER_ROLE_ID = '1445443506175873164';      

const DB_FILE = './attendance.json';
const REWARD_FILE = './rewards.json';
const STICKY_FILE = './sticky.json'; 

const stickyMessages = new Map(); 
const isStickyUpdating = new Set(); 

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// ==========================================
// [2] 유틸리티 함수
// ==========================================
const loadDB = (file) => {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({}));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const saveDB = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

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
    let targetRoleCount = 0;
    let targetRoleId = null;

    for (const [reqCount, roleId] of Object.entries(rewards)) {
        const req = parseInt(reqCount);
        if (currentCount >= req && req > targetRoleCount) {
            targetRoleCount = req;
            targetRoleId = roleId;
        }
    }

    if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
        try {
            const allRewardRoles = Object.values(rewards);
            await member.roles.remove(allRewardRoles);
            await member.roles.add(targetRoleId);
            return true;
        } catch (error) {
            console.error('역할 변경 실패:', error);
        }
    }
    return false;
}

// ------------------------------------------
// 🛠 고정 메시지 전용 유틸리티
// ------------------------------------------
async function deleteMessageSafe(channel, messageId) {
    if (!messageId) return;
    try {
        const oldMsg = await channel.messages.fetch(messageId);
        if (oldMsg) await oldMsg.delete();
    } catch (error) {
        // 무시
    }
}

async function sendStickyEmbed(channel, content) {
    const stickyEmbed = new EmbedBuilder()
        .setTitle('📌 [ 공지 ]')
        .setDescription(content)
        .setColor('#ff9839');
    return await channel.send({ embeds: [stickyEmbed] });
}

function saveStickyData(channelId, data) {
    stickyMessages.set(channelId, data);
    const db = loadDB(STICKY_FILE);
    db[channelId] = data;
    saveDB(STICKY_FILE, db);
}

function removeStickyData(channelId) {
    stickyMessages.delete(channelId);
    const db = loadDB(STICKY_FILE);
    delete db[channelId];
    saveDB(STICKY_FILE, db);
}

// ==========================================
// [3] 슬래시 명령어 세팅
// ==========================================
const commands = [
    new SlashCommandBuilder()
        .setName('출석조절')
        .setDescription('유저의 출석 횟수를 변경합니다. (관리자 전용)')
        .addUserOption(opt => opt.setName('대상').setDescription('출석 횟수를 변경할 유저를 선택하세요').setRequired(true))
        .addIntegerOption(opt => opt.setName('횟수').setDescription('변경할 숫자를 입력하세요').setRequired(true)),
    new SlashCommandBuilder()
        .setName('보상설정')
        .setDescription('출석 달성 시 지급할 역할을 세팅합니다. (관리자 전용)')
        .addIntegerOption(opt => opt.setName('목표횟수').setDescription('몇 회 달성 시 지급할지 숫자를 입력하세요').setRequired(true))
        .addRoleOption(opt => opt.setName('지급역할').setDescription('달성 시 유저에게 줄 역할을 선택하세요').setRequired(true)),
    new SlashCommandBuilder()
        .setName('고정공지')
        .setDescription('채널 맨 아래를 따라다니는 고정 공지를 설정합니다. (관리자 전용)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // 🚀 [수정] 옵션을 없애고 팝업창을 띄우도록 변경
    new SlashCommandBuilder()
        .setName('공지해지')
        .setDescription('현재 채널의 고정 공지를 해제합니다. (관리자 전용)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON());

// ==========================================
// [4] 봇 준비 및 이벤트 핸들러
// ==========================================
client.once('ready', async () => {
    console.log(`✅ 봇이 온라인 상태가 되었습니다! 로그인된 계정: ${client.user.tag}`);
    
    const savedStickies = loadDB(STICKY_FILE);
    for (const [chId, data] of Object.entries(savedStickies)) {
        stickyMessages.set(chId, data);
    }
    console.log(`📌 로드된 고정 메시지 채널 수: ${stickyMessages.size}개`);

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        console.log('⏳ 슬래시 명령어를 서버에 업데이트하는 중...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ 슬래시 명령어 등록 완료!');
    } catch (error) {
        console.error('❌ 명령어 등록 실패:', error);
    }
});

// ==========================================
// [5] 채팅 메시지 이벤트 (!출석 및 고정 메시지 갱신)
// ==========================================
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // 1. 출석 체크 로직
    if (message.content === '!출석') {
        if (message.channelId !== ATTENDANCE_CHANNEL_ID) {
            return message.reply('❌ 지정된 출석 채널에서만 출석할 수 있습니다.');
        } 
        
        const db = loadDB(DB_FILE);
        const userId = message.author.id;
        const todayInfo = getTodayInfo();
        const userData = getUserDB(db, userId);

        if (userData.lastDate === todayInfo.dateString) {
            return message.reply('✅ 오늘은 이미 출석하셨습니다! 내일 다시 와주세요.');
        } 
        
        userData.count += 1;
        userData.lastDate = todayInfo.dateString;
        saveDB(DB_FILE, db);

        let replyMsg = `📅 **${todayInfo.dateString} (${todayInfo.dayName})**\n✅ **${message.member.displayName}**님, 출석 완료! (총 출석 횟수: **${userData.count}회**)`;

        const isUpgraded = await updateRoles(message.member, userData.count);
        if (isUpgraded) {
            replyMsg += `\n🎉 **역할 업그레이드!** 기존 역할이 회수되고 새로운 달성 역할을 획득하셨습니다!`;
        }

        await message.reply(replyMsg);
    }

    // 2. 누군가 채팅을 쳤을 때 고정 메시지 끌어내리기
    if (stickyMessages.has(message.channelId)) {
        if (isStickyUpdating.has(message.channelId)) return;
        
        isStickyUpdating.add(message.channelId);

        try {
            const stickyData = stickyMessages.get(message.channelId);
            await deleteMessageSafe(message.channel, stickyData.lastMessageId);
            const sentMessage = await sendStickyEmbed(message.channel, stickyData.content);
            stickyData.lastMessageId = sentMessage.id;
            saveStickyData(message.channelId, stickyData);
        } finally {
            isStickyUpdating.delete(message.channelId);
        }
    }
});

// ==========================================
// [6] 슬래시 명령어 및 팝업(모달) 이벤트 핸들러
// ==========================================
client.on('interactionCreate', async interaction => {
    // ------------------------------------------
    // 🚀 [새로운 기능] 모달창(팝업) 제출 이벤트 처리
    // ------------------------------------------
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'stickyModal') {
            // 사용자가 모달창에 엔터키 포함해서 입력한 텍스트 그대로 가져오기
            const content = interaction.fields.getTextInputValue('stickyContent');

            const existingData = stickyMessages.get(interaction.channelId);
            if (existingData) {
                await deleteMessageSafe(interaction.channel, existingData.lastMessageId);
            }

            const sentMessage = await sendStickyEmbed(interaction.channel, content);
            saveStickyData(interaction.channelId, { content: content, lastMessageId: sentMessage.id });

            return interaction.reply({ content: '✅ 고정 공지가 설정되었습니다.', ephemeral: true });
        }
        return;
    }

    // ------------------------------------------
    // 기존 슬래시 명령어 처리
    // ------------------------------------------
    if (!interaction.isChatInputCommand()) return;

    const command = interaction.commandName;
    const isManager = interaction.member.roles.cache.has(MANAGER_ROLE_ID) || interaction.member.permissions.has('Administrator');

    if (!isManager) {
        return interaction.reply({ content: '❌ 이 명령어를 사용할 권한이 없습니다.', ephemeral: true });
    }

    if (command === '출석조절') {
        const targetUser = interaction.options.getUser('대상');
        const newCount = interaction.options.getInteger('횟수');
        const db = loadDB(DB_FILE);
        const userData = getUserDB(db, targetUser.id);
        userData.count = newCount;
        saveDB(DB_FILE, db);
        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (targetMember) await updateRoles(targetMember, newCount);
        const targetName = targetMember ? targetMember.displayName : targetUser.username;
        return interaction.reply(`🔧 **${targetName}**님의 출석 횟수가 **${newCount}회**로 변경되었으며, 역할이 업데이트되었습니다.`);
    }

    if (command === '보상설정') {
        const reqCount = interaction.options.getInteger('목표횟수');
        const role = interaction.options.getRole('지급역할');
        const rewards = loadDB(REWARD_FILE);
        rewards[reqCount] = role.id;
        saveDB(REWARD_FILE, rewards);
        return interaction.reply(`✅ 세팅 완료! 앞으로 출석 **${reqCount}회** 달성 시 **<@&${role.id}>** 역할이 지급됩니다.`);
    }

    // 🚀 [수정] 텍스트 입력창 대신 모달(팝업) 띄우기
    if (command === '고정공지') {
        const modal = new ModalBuilder()
            .setCustomId('stickyModal')
            .setTitle('고정 공지 설정');

        // Paragraph 스타일을 사용하면 사용자가 엔터를 치며 넓은 화면에서 작성할 수 있습니다.
        const stickyInput = new TextInputBuilder()
            .setCustomId('stickyContent')
            .setLabel('공지할 내용을 입력하세요 (엔터로 줄바꿈 가능)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(stickyInput);
        modal.addComponents(firstActionRow);

        // 유저에게 모달 창을 보여줍니다.
        await interaction.showModal(modal);
    }

    if (command === '공지해지') {
        const existingData = stickyMessages.get(interaction.channelId);
        if (existingData) {
            await deleteMessageSafe(interaction.channel, existingData.lastMessageId);
            removeStickyData(interaction.channelId);
            return interaction.reply({ content: '✅ 이 채널의 고정 메시지가 해제되었습니다.', ephemeral: true });
        } else {
            return interaction.reply({ content: '❌ 이 채널에는 설정된 고정 메시지가 없습니다.', ephemeral: true });
        }
    }
});
// ==========================================
// [7] TTS 봇 전체 코드
// ==========================================
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const googleTTS = require('google-tts-api');

// ==========================================
// [1] 기본 설정 (수정 필요)
// ==========================================
const TTS_CHANNEL_ID = '1505249610632007861'; // 👈 이 채널에서만 봇이 작동합니다.

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates // 음성 채널 접속을 위해 필수
    ]
});

let currentConnection = null;
const audioPlayer = createAudioPlayer();

client.once('ready', () => {
    console.log(`✅ ${client.user.tag} TTS 봇 구동 완료!`);
    console.log(`📌 허용된 TTS 채널 ID: ${TTS_CHANNEL_ID}`);
});

// ==========================================
// [2] 메시지 이벤트 핸들러
// ==========================================
client.on('messageCreate', async (message) => {
    // 봇이 보낸 메시지는 무시
    if (message.author.bot) return;

    // 🚀 [핵심] 지정된 텍스트 채널이 아니면 무시
    if (message.channelId !== TTS_CHANNEL_ID) return;

    // --------------------------------------------------
    // 기능 1: 봇 음성 채널 입장 (!입장)
    // --------------------------------------------------
    if (message.content === '!입장') {
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.reply('❌ 봇을 부르려면 먼저 음성 채널에 들어가주세요!');
        }

        currentConnection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
        });

        currentConnection.subscribe(audioPlayer); 
        return message.reply('✅ 음성 채널에 입장했습니다! 지금부터 이 채널에 치는 채팅을 읽어드립니다.');
    }

    // --------------------------------------------------
    // 기능 2: 봇 음성 채널 퇴장 (!퇴장)
    // --------------------------------------------------
    if (message.content === '!퇴장') {
        if (currentConnection) {
            currentConnection.destroy();
            currentConnection = null;
            return message.reply('👋 음성 채널에서 퇴장합니다.');
        }
        return message.reply('❌ 현재 연결된 음성 채널이 없습니다.');
    }

    // --------------------------------------------------
    // 기능 3: 채팅을 음성으로 읽어주기
    // --------------------------------------------------
    // 명령어가 아니고(!로 시작하지 않음), 봇이 음성 채널에 연결되어 있을 때만 실행
    if (!message.content.startsWith('!') && currentConnection) {
        
        // 글자 수 제한 (구글 TTS 무료 API는 200자 제한이 있음)
        let textToRead = message.content;
        if (textToRead.length > 200) {
            textToRead = textToRead.substring(0, 197) + "..."; // 200자 넘으면 자르고 읽음
        }

        try {
            // Google TTS API로 텍스트를 음성 URL로 변환
            const url = googleTTS.getAudioUrl(textToRead, {
                lang: 'ko',  // 한국어
                slow: false, // 속도 정상
                host: 'https://translate.google.com',
            });

            // 오디오 재생
            const resource = createAudioResource(url);
            audioPlayer.play(resource);
            
        } catch (error) {
            console.error('❌ TTS 변환 오류:', error);
        }
    }
});
// ==========================================
// [8] 24시간 유지를 위한 웹서버 (Express)
// ==========================================

const app = express();
app.get('/', (req, res) => res.send('봇이 정상적으로 작동 중입니다.'));
app.listen(process.env.PORT || 3000, () => console.log(`🌐 웹서버가 실행 중입니다.`));

client.login(TOKEN);