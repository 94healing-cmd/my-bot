const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');
const fs = require('fs');
const express = require('express'); // 24시간 유지를 위한 웹서버 모듈 추가

// ==========================================
// [1] 기본 설정 (토큰 및 ID)
// ==========================================
// 🚨 보안을 위해 코드에 토큰을 직접 적지 않고 Render 환경 변수에서 가져옵니다.
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
function loadDB(file) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({}));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveDB(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getTodayInfo() {
    const now = new Date();
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    return {
        dateString: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
        dayName: `${days[now.getDay()]}요일`              
    };
}

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
            return false;
        }
    }
    return false;
}

// ==========================================
// [3] 슬래시 명령어 세팅
// ==========================================
const commands = [
    new SlashCommandBuilder()
        .setName('출석조절')
        .setDescription('유저의 출석 횟수를 변경합니다. (관리자 전용)')
        .addUserOption(option => option.setName('대상').setDescription('출석 횟수를 변경할 유저를 선택하세요').setRequired(true))
        .addIntegerOption(option => option.setName('횟수').setDescription('변경할 숫자를 입력하세요').setRequired(true)),
    new SlashCommandBuilder()
        .setName('보상설정')
        .setDescription('출석 달성 시 지급할 역할을 세팅합니다. (관리자 전용)')
        .addIntegerOption(option => option.setName('목표횟수').setDescription('몇 회 달성 시 지급할지 숫자를 입력하세요').setRequired(true))
        .addRoleOption(option => option.setName('지급역할').setDescription('달성 시 유저에게 줄 역할을 선택하세요').setRequired(true)),
    new SlashCommandBuilder()
        .setName('공지')
        .setDescription('채널에 공지사항을 전송합니다. (관리자 전용)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option => option.setName('내용').setDescription('공지할 내용을 입력하세요').setRequired(true))
].map(command => command.toJSON());

// ==========================================
// [4] 봇 준비 이벤트
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
// [5] 채팅 메시지 이벤트 (!출석 + 고정 메시지 갱신 + ?stick 명령어)
// ==========================================
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const channelId = message.channel.id;
    const isManager = message.member.permissions.has('Administrator') || message.member.roles.cache.has(MANAGER_ROLE_ID);

    if (message.content.startsWith('?stick ')) {
        if (!isManager) return message.reply('❌ 관리자만 사용할 수 있습니다.');
        
        const content = message.content.slice(7).trim();
        if (!content) return message.reply('⚠️ 고정할 내용을 입력해주세요.');

        const existing = stickyMessages.get(channelId);
        if (existing && existing.lastMessageId) {
            try {
                const oldMsg = await message.channel.messages.fetch(existing.lastMessageId);
                if (oldMsg) await oldMsg.delete();
            } catch (e) {}
        }

        const stickyEmbed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('📌 [ 고정 안내 ]')
            .setDescription(`\`\`\`\n${content}\n\`\`\``);

        const newMsg = await message.channel.send({ embeds: [stickyEmbed] });
        
        stickyMessages.set(channelId, { content: content, lastMessageId: newMsg.id });
        saveDB(STICKY_FILE, Object.fromEntries(stickyMessages));
        
        await message.delete().catch(() => {});
        return;
    }

    if (message.content === '?unstick') {
        if (!isManager) return message.reply('❌ 관리자만 사용할 수 있습니다.');
        
        if (stickyMessages.has(channelId)) {
            const existing = stickyMessages.get(channelId);
            try {
                const oldMsg = await message.channel.messages.fetch(existing.lastMessageId);
                if (oldMsg) await oldMsg.delete();
            } catch (e) {}

            stickyMessages.delete(channelId);
            saveDB(STICKY_FILE, Object.fromEntries(stickyMessages));
            
            const reply = await message.reply('✅ 고정 메시지가 해제되었습니다.');
            setTimeout(() => {
                reply.delete().catch(() => {});
                message.delete().catch(() => {});
            }, 3000);
        }
        return;
    }

    if (message.content === '!출석') {
        if (channelId !== ATTENDANCE_CHANNEL_ID) {
            await message.reply('❌ 지정된 출석 채널에서만 출석할 수 있습니다.');
        } else {
            const db = loadDB(DB_FILE);
            const userId = message.author.id;
            const todayInfo = getTodayInfo();

            if (!db[userId]) db[userId] = { count: 0, lastDate: '' };

            if (db[userId].lastDate === todayInfo.dateString) {
                await message.reply('✅ 오늘은 이미 출석하셨습니다! 내일 다시 와주세요.');
            } else {
                db[userId].count += 1;
                db[userId].lastDate = todayInfo.dateString;
                saveDB(DB_FILE, db);

                let replyMsg = `📅 **${todayInfo.dateString} (${todayInfo.dayName})**\n✅ **${message.member.displayName}**님, 출석 완료! (총 출석 횟수: **${db[userId].count}회**)`;

                const isUpgraded = await updateRoles(message.member, db[userId].count);
                if (isUpgraded) {
                    replyMsg += `\n🎉 **역할 업그레이드!** 기존 역할이 회수되고 새로운 달성 역할을 획득하셨습니다!`;
                }

                await message.reply(replyMsg);
            }
        }
    }

    const stickyData = stickyMessages.get(channelId);
    if (stickyData) {
        if (stickyData.lastMessageId) {
            try {
                const oldMsg = await message.channel.messages.fetch(stickyData.lastMessageId);
                if (oldMsg) await oldMsg.delete();
            } catch (error) {}
        }

        const stickyEmbed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('📌 [ 고정 안내 ]')
            .setDescription(`\`\`\`\n${stickyData.content}\n\`\`\``);

        try {
            const newMsg = await message.channel.send({ embeds: [stickyEmbed] });
            stickyData.lastMessageId = newMsg.id;
            stickyMessages.set(channelId, stickyData);
            saveDB(STICKY_FILE, Object.fromEntries(stickyMessages));
        } catch (error) {
            console.error('고정 메시지 갱신 오류:', error);
        }
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

        if (!db[targetUser.id]) db[targetUser.id] = { count: 0, lastDate: '' };
        db[targetUser.id].count = newCount;
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
        
        const noticeEmbed = new EmbedBuilder()
            .setColor('#2B2D31')
            .setTitle('📢 [ 공 지 사 항 ]')
            .setDescription(content)
            .setTimestamp()
            .setFooter({ text: `${interaction.member.displayName}님이 작성함`, iconURL: interaction.user.displayAvatarURL() });

        await interaction.channel.send({ embeds: [noticeEmbed] });
        return interaction.reply({ content: '✅ 공지가 채널에 전송되었습니다.', ephemeral: true });
    }
});

// ==========================================
// [7] 24시간 유지를 위한 가짜 웹서버 (Express)
// ==========================================
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('봇이 24시간 살아있습니다!');
});

app.listen(port, () => {
    console.log(`🌐 가짜 웹서버가 포트 ${port}에서 실행 중입니다.`);
});

// 디스코드 봇 로그인 실행
client.login(TOKEN);