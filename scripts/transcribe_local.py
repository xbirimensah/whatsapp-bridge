"""Local voice-note transcription with mlx-whisper (Apple Silicon).

Usage: transcribe_local.py <audio-file> [hf-model-repo]
Prints the transcript to stdout. Needs ffmpeg on PATH.
"""
import sys

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: transcribe_local.py <audio-file> [model]", file=sys.stderr)
        return 2
    import mlx_whisper

    model = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else DEFAULT_MODEL
    result = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=model)
    sys.stdout.write((result.get("text") or "").strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
