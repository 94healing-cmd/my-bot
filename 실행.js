const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    PermissionFlagsBits,
    EmbedBuilder,
    ModalBuilder,         // 팝업창(모달) 생성 기능
    TextInputBuilder,     // 팝업창 안의 텍스트 입력칸 기능
    TextInputStyle,       // 텍스트 입력칸의 스타일
    ActionRowBuilder      // 팝업창 레이아웃 구성 기능
} = require('discord.js');
const fs = require('fs');

// ==========================================
// [1] 기본 설정 (토큰 및 ID)
// ==========================================
// 👇 반드시 디스코드 개발자 포털에서 토큰을 리셋하고 새 토큰을 넣으세요!
const TOKEN = 'DISCORD_TOKEN';
const CLIENT_ID = '1504881356021170226';

const ATTENDANCE_CHANNEL_ID = '1445449644678320198'; 
const MANAGER_ROLE_ID = '1445443506175873164';       

const DB_FILE = './attendance.json';
const REWARD_FILE = './rewards.json';

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
        .setName('고정')
        .setDescription('이 채널의 맨 아래에 공지를 고정합니다. (모달 창이 열립니다)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('고정해제')
        .setDescription('이 채널의 고정 메시지를 해제합니다. (관리자 전용)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON()); // ✨ [수정됨] 이 부분이 있어야 명령어가 정상적으로 등록됩니다!

// ==========================================
// [4] 봇 준비 이벤트
// ==========================================
client.once('ready', async () => {
    console.log(`✅ 봇이 온라인 상태가 되었습니다! 로그인된 계정: ${client.user.tag}`);
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
// [5] 채팅 메시지 이벤트 (!출석 + 고정 메시지)
// ==========================================
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // [출석 기능]
    if (message.content === '!출석') {
        if (message.channel.id !== ATTENDANCE_CHANNEL_ID) {
            return message.reply('❌ 지정된 출석 채널에서만 출석할 수 있습니다.');
        } 
        
        const db = loadDB(DB_FILE);
        const userId = message.author.id;
        const todayInfo = getTodayInfo();

        if (!db[userId]) db[userId] = { count: 0, lastDate: '' };

        if (db[userId].lastDate === todayInfo.dateString) {
            return message.reply('✅ 오늘은 이미 출석하셨습니다! 내일 다시 와주세요.');
        } 
        
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

    // [고정 메시지 갱신 기능]
    const channelId = message.channel.id;
    const stickyData = stickyMessages.get(channelId);

    if (stickyData) {
        if (stickyData.lastMessageId) {
            try {
                const oldMsg = await message.channel.messages.fetch(stickyData.lastMessageId);
                if (oldMsg) await oldMsg.delete();
            } catch (error) {
                // 이미 지워졌거나 찾을 수 없는 경우 무시
            }
        }

        const stickyEmbed = new EmbedBuilder()
            .setColor('#FFD700') 
            .setTitle('📌 [ 고정 안내 ]')
            .setDescription(`\`\`\`\n${stickyData.content}\n\`\`\``); 

        try {
            const newMsg = await message.channel.send({ embeds: [stickyEmbed] });
            stickyData.lastMessageId = newMsg.id;
            stickyMessages.set(channelId, stickyData);
        } catch (error) {
            console.error('메시지 전송 오류:', error);
        }
    }
});

// ==========================================
// [6] 슬래시 명령어 & 모달 상호작용 이벤트
// ==========================================
client.on('interactionCreate', async interaction => {
    
    // ⚡ A. 슬래시 명령어를 쳤을 때
    if (interaction.isChatInputCommand()) {
        const command = interaction.commandName;
        const channelId = interaction.channelId;

        // [출석 시스템 관리자 명령어]
        if (command === '출석조절' || command === '보상설정') {
            const isManager = interaction.member.roles.cache.has(MANAGER_ROLE_ID) || interaction.member.permissions.has('Administrator');
            if (!isManager) return interaction.reply({ content: '❌ 이 명령어를 사용할 권한이 없습니다.', ephemeral: true });

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

                return interaction.reply(`✅ 세팅 완료! 앞으로 출석 **${reqCount}회** 달성 시 **[@${role.name}]** 역할이 지급됩니다.`);
            }
        }

        // [고정 해제 명령어]
        if (command === '고정해제') {
            if (stickyMessages.has(channelId)) {
                stickyMessages.delete(channelId);
                return interaction.reply({ content: '✅ 고정 메시지가 해제되었습니다.', ephemeral: true });
            } else {
                return interaction.reply({ content: '⚠️ 이 채널에는 고정된 메시지가 없습니다.', ephemeral: true });
            }
        }

        // [고정 명령어] -> 팝업창(모달) 띄우기
        if (command === '고정') {
            const modal = new ModalBuilder()
                .setCustomId('stickyModal')
                .setTitle('📌 고정 공지 설정');

            const contentInput = new TextInputBuilder()
                .setCustomId('stickyContent')
                .setLabel('공지할 내용을 입력하세요 (엔터키 사용 가능!)')
                .setStyle(TextInputStyle.Paragraph) 
                .setRequired(true);

            const actionRow = new ActionRowBuilder().addComponents(contentInput);
            modal.addComponents(actionRow);

            return interaction.showModal(modal);
        }
    }

    // ⚡ B. 팝업창(모달)에 내용을 적고 '제출' 버튼을 눌렀을 때
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'stickyModal') {
            const content = interaction.fields.getTextInputValue('stickyContent');
            const channelId = interaction.channelId;
            
            stickyMessages.set(channelId, { content: content, lastMessageId: null });
            await interaction.reply({ content: '✅ 이 채널에 공지가 고정되었습니다.', ephemeral: true });
            
            const stickyEmbed = new EmbedBuilder()
                .setColor('#FFD700') 
                .setTitle('📌 [ 고정 안내 ]')
                .setDescription(`\`\`\`\n${content}\n\`\`\``);

            const newMsg = await interaction.channel.send({ embeds: [stickyEmbed] });
            stickyMessages.get(channelId).lastMessageId = newMsg.id;
        }
    }
});
client.login(TOKEN);