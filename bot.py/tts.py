import discord
from discord.ext import commands
from discord import app_commands
import edge_tts
import asyncio
import os

# --- 설정 부분 ---
# 봇이 읽어줄 특정 텍스트 채널의 ID를 입력하세요.
TARGET_CHANNEL_ID = 123456789012345678  

# 봇 기본 설정
intents = discord.Intents.default()
intents.message_content = True
intents.voice_states = True
bot = commands.Bot(command_prefix="!", intents=intents)

# TTS 활성화 상태 및 유저별 목소리 설정 저장 딕셔너리
tts_active = False
user_voices = {}

# 목소리 프로필 설정 (Edge TTS의 음정 조절을 통해 연령대 구현)
VOICE_PROFILES = {
    "남성_어린이": {"voice": "ko-KR-InJoonNeural", "pitch": "+25Hz"},
    "남성_학생": {"voice": "ko-KR-InJoonNeural", "pitch": "+10Hz"},
    "남성_성인": {"voice": "ko-KR-InJoonNeural", "pitch": "+0Hz"},
    "여성_어린이": {"voice": "ko-KR-SunHiNeural", "pitch": "+25Hz"},
    "여성_학생": {"voice": "ko-KR-SunHiNeural", "pitch": "+10Hz"},
    "여성_성인": {"voice": "ko-KR-SunHiNeural", "pitch": "+0Hz"}
}

@bot.event
async def on_ready():
    print(f'{bot.user} 봇이 성공적으로 로그인했습니다!')
    try:
        # 슬래시 명령어 동기화
        synced = await bot.tree.sync()
        print(f"{len(synced)}개의 슬래시 명령어가 동기화되었습니다.")
    except Exception as e:
        print(f"명령어 동기화 실패: {e}")

# --- 슬래시 명령어 (/기능) ---

@bot.tree.command(name="tts_켜기", description="음성 채널에 접속하고 지정된 채널의 채팅 읽기를 시작합니다.")
async def start_tts(interaction: discord.Interaction):
    global tts_active
    
    if not interaction.user.voice:
        await interaction.response.send_message("먼저 음성 채널에 접속해주세요!", ephemeral=True)
        return

    channel = interaction.user.voice.channel
    
    # 봇이 이미 음성 채널에 들어가 있지 않다면 접속
    if not interaction.guild.voice_client:
        await channel.connect()
    
    tts_active = True
    await interaction.response.send_message(f"✅ TTS가 활성화되었습니다. 이제 <#{TARGET_CHANNEL_ID}> 채널의 채팅을 읽어줍니다.")

@bot.tree.command(name="tts_끄기", description="TTS 기능을 끄고 음성 채널에서 퇴장합니다.")
async def stop_tts(interaction: discord.Interaction):
    global tts_active
    
    if interaction.guild.voice_client:
        await interaction.guild.voice_client.disconnect()
        tts_active = False
        await interaction.response.send_message("🛑 TTS가 종료되고 봇이 퇴장했습니다.")
    else:
        await interaction.response.send_message("봇이 음성 채널에 있지 않습니다.", ephemeral=True)

@bot.tree.command(name="목소리", description="내 TTS 목소리를 변경합니다.")
@app_commands.describe(선택="원하는 목소리를 선택하세요")
@app_commands.choices(선택=[
    app_commands.Choice(name="👦 남성 (어린이)", value="남성_어린이"),
    app_commands.Choice(name="🧑 남성 (학생)", value="남성_학생"),
    app_commands.Choice(name="👨 남성 (성인)", value="남성_성인"),
    app_commands.Choice(name="👧 여성 (어린이)", value="여성_어린이"),
    app_commands.Choice(name="👩 여성 (학생)", value="여성_학생"),
    app_commands.Choice(name="👩‍🦰 여성 (성인)", value="여성_성인"),
])
async def set_voice(interaction: discord.Interaction, 선택: app_commands.Choice[str]):
    user_voices[interaction.user.id] = 선택.value
    await interaction.response.send_message(f"✅ {interaction.user.name}님의 목소리가 **{선택.name}**(으)로 변경되었습니다!")

# --- 채팅 자동 읽기 기능 ---

@bot.event
async def on_message(message: discord.Message):
    global tts_active

    # 봇 자신의 메시지이거나, TTS가 꺼져있거나, 지정된 채널이 아니면 무시
    if message.author.bot or not tts_active or message.channel.id != TARGET_CHANNEL_ID:
        # on_message를 오버라이딩하면 기본 명령어가 씹힐 수 있으므로 아래 코드 추가
        await bot.process_commands(message)
        return

    # 봇이 음성 채널에 연결되어 있는지 확인
    voice_client = message.guild.voice_client
    if not voice_client or not voice_client.is_connected():
        await bot.process_commands(message)
        return

    # 유저별 지정된 목소리 가져오기 (기본값: 여성_성인)
    user_voice_choice = user_voices.get(message.author.id, "여성_성인")
    profile = VOICE_PROFILES[user_voice_choice]

    # 오디오 파일 생성 (비동기 처리)
    text_to_read = message.content
    file_name = f"tts_{message.id}.mp3"
    
    communicate = edge_tts.Communicate(text_to_read, profile["voice"], pitch=profile["pitch"])
    await communicate.save(file_name)

    # 이전 오디오가 재생 중이면 끝날 때까지 대기 (간단한 큐 구현)
    while voice_client.is_playing():
        await asyncio.sleep(0.5)

    # 오디오 재생
    try:
        source = discord.FFmpegPCMAudio(file_name)
        voice_client.play(source, after=lambda e: os.remove(file_name) if os.path.exists(file_name) else None)
    except Exception as e:
        print(f"오디오 재생 오류: {e}")
        if os.path.exists(file_name):
            os.remove(file_name)

    # 이벤트 처리 후 다른 커맨드도 정상 작동하도록 추가
    await bot.process_commands(message)

# 봇 실행 (토큰 입력 필수)
bot.run('YOUR_BOT_TOKEN_HERE')