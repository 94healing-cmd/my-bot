const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits
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

// ==========================================
// [3] 슬래시 명령어 세팅 (고정공지, 공지해지 추가)
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
        .setName('공지')
        .setDescription('채널에 일반 공지사항을 전송합니다. (관리자 전용)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(opt => opt.setName('내용').setDescription('공지할 내용을 입력하세요').setRequired(true)),
    new SlashCommandBuilder()
        .setName('고정공지')
        .setDescription('채널 맨 아래를 따라다니는 고정 공지를 설정합니다. (관리자 전용)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(opt => opt.setName('내용').setDescription('고정할 공지 내용을 입력하세요').setRequired(true)),
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
    // 봇이 보낸 메시지는 무시
    if (message.author.bot) return;

    // --------------------------------------------------
    // 1. 출석 체크 로직
    // --------------------------------------------------
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

    // --------------------------------------------------
    // 2. 누군가 채팅을 쳤을 때 고정 메시지 끌어내리기 (갱신)
    // --------------------------------------------------
    if (stickyMessages.has(message.channelId)) {
        const stickyData = stickyMessages.get(message.channelId);
        
        // 1) 기존 고정 메시지 삭제 시도
        if (stickyData.lastMessageId) {
            try {
                const oldMsg = await message.channel.messages.fetch(stickyData.lastMessageId);
                if (oldMsg) await oldMsg.delete();
            } catch (error) {
                // 수동 삭제 등 예외 무시
            }
        }

        // 2) 맨 아래에 새 메시지로 다시 전송
        const sentMessage = await message.channel.send(`📌 **[채널 공지]**\n\n${stickyData.content}`);
        
        // 3) 새로 보낸 메시지의 ID를 갱신하여 저장
        stickyData.lastMessageId = sentMessage.id;
        stickyMessages.set(message.channelId, stickyData);
        
        const db = loadDB(STICKY_FILE);
        db[message.channelId] = stickyData;
        saveDB(STICKY_FILE, db);
    }
});

// ==========================================
// [6] 슬래시 명령어 이벤트 핸들러
// ==========================================
client.on('interactionCreate', async interaction => {
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

    if (command === '공지') {
        const content = interaction.options.getString('내용');
        await interaction.channel.send(content);
        return interaction.reply({ content: '✅ 일반 공지가 전송되었습니다.', ephemeral: true });
    }

    if (command === '고정공지') {
        const content = interaction.options.getString('내용');

        // 기존 고정 메시지 삭제
        const existingData = stickyMessages.get(interaction.channelId);
        if (existingData && existingData.lastMessageId) {
            try {
                const oldMsg = await interaction.channel.messages.fetch(existingData.lastMessageId);
                if (oldMsg) await oldMsg.delete();
            } catch (error) {}
        }

        // 새 고정 메시지 전송
        const sentMessage = await interaction.channel.send(`📌 **[채널 공지]**\n\n${content}`);

        // 데이터 저장
        const stickyData = { content: content, lastMessageId: sentMessage.id };
        stickyMessages.set(interaction.channelId, stickyData);
        
        const db = loadDB(STICKY_FILE);
        db[interaction.channelId] = stickyData;
        saveDB(STICKY_FILE, db);

        // 명령어 응답 (관리자만 볼 수 있게)
        return interaction.reply({ content: '✅ 고정 공지가 설정되었습니다.', ephemeral: true });
    }

    if (command === '공지해지') {
        const existingData = stickyMessages.get(interaction.channelId);
        if (existingData) {
            if (existingData.lastMessageId) {
                try {
                    const oldMsg = await interaction.channel.messages.fetch(existingData.lastMessageId);
                    if (oldMsg) await oldMsg.delete();
                } catch (error) {}
            }
            
            // 데이터 삭제
            stickyMessages.delete(interaction.channelId);
            const db = loadDB(STICKY_FILE);
            delete db[interaction.channelId];
            saveDB(STICKY_FILE, db);
            
            return interaction.reply({ content: '✅ 이 채널의 고정 메시지가 해제되었습니다.', ephemeral: true });
        } else {
            return interaction.reply({ content: '❌ 이 채널에는 설정된 고정 메시지가 없습니다.', ephemeral: true });
        }
    }
});

// ==========================================
// [7] 24시간 유지를 위한 웹서버 (Express)
// ==========================================
const app = express();
app.get('/', (req, res) => res.send('봇이 정상적으로 작동 중입니다.'));
app.listen(process.env.PORT || 3000, () => console.log(`🌐 웹서버가 실행 중입니다.`));

client.login(TOKEN);