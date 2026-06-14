import os
import sys
import wave
import struct

# Add current directory to python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from ai_service import AIService
import config

def create_silent_wav(filename, duration=1.0, sample_rate=16000):
    print(f"Creating silent test WAV file: {filename}...")
    with wave.open(filename, 'wb') as wav_file:
        wav_file.setparams((1, 2, sample_rate, int(sample_rate * duration), 'NONE', 'not compressed'))
        for _ in range(int(sample_rate * duration)):
            wav_file.writeframes(struct.pack('<h', 0))

def test_local_whisper():
    print("Testing local Whisper configuration...")
    print(f"USE_LOCAL_WHISPER: {config.USE_LOCAL_WHISPER}")
    print(f"LOCAL_WHISPER_MODEL_PATH: {config.LOCAL_WHISPER_MODEL_PATH}")
    print(f"WHISPER_THREADS: {config.WHISPER_THREADS}")

    # Check if model path exists
    if not os.path.exists(config.LOCAL_WHISPER_MODEL_PATH):
        print(f"ERROR: Model file not found at {config.LOCAL_WHISPER_MODEL_PATH}")
        sys.exit(1)
    else:
        print(f"SUCCESS: Model file found at {config.LOCAL_WHISPER_MODEL_PATH} (size: {os.path.getsize(config.LOCAL_WHISPER_MODEL_PATH)} bytes)")

    test_wav = "test_silent.wav"
    create_silent_wav(test_wav)

    try:
        print("Invoking AIService.transcribe_audio...")
        transcription = AIService.transcribe_audio(test_wav)
        print(f"Transcription result: '{transcription}'")
        print("SUCCESS: Local Whisper test run completed.")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"ERROR: Local Whisper transcription failed: {e}")
        sys.exit(1)
    finally:
        if os.path.exists(test_wav):
            os.remove(test_wav)

if __name__ == "__main__":
    test_local_whisper()
