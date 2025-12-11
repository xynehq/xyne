#!/usr/bin/env python3
"""
Simplified ASR + Speaker Diarization Script
Only handles Whisper transcription and Pyannote speaker diarization in parallel.
All post-processing (merging, chunking, LLM refinement) is handled in TypeScript.
"""

import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import torch
import whisper
from pyannote.audio import Pipeline
from pyannote.core import Annotation


class ParallelWhisperDiarization:
    """Runs Whisper and Pyannote in parallel, merges results deterministically."""

    def __init__(
        self,
        whisper_model: str = "turbo",
        diarization_model: str = "pyannote/speaker-diarization-3.1",
        device: Optional[str] = None,
        hf_token: Optional[str] = None,
    ):
        if device is None:
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            self.device = device

        print(f"Using device: {self.device}")

        # Load Whisper model exactly as requested
        print(f"Loading Whisper model: {whisper_model}...")
        self.whisper_model = whisper.load_model(whisper_model, device=self.device)

        # Load pyannote diarization pipeline
        print(f"Loading diarization model: {diarization_model}...")
        if hf_token:
            self.diarization_pipeline = Pipeline.from_pretrained(
                diarization_model, token=hf_token
            )
        else:
            try:
                self.diarization_pipeline = Pipeline.from_pretrained(diarization_model)
            except Exception as e:
                print("\nError: Pyannote models require HuggingFace authentication.")
                print("Please provide a HuggingFace token using --hf-token")
                raise e

        # Move diarization to the same device
        if self.device == "cuda" and torch.cuda.is_available():
            try:
                self.diarization_pipeline.to(torch.device("cuda"))
            except Exception:
                # Not all components may support .to("cuda"); silently fall back
                pass

    def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        num_speakers: Optional[int] = None,
        min_speakers: Optional[int] = None,
        max_speakers: Optional[int] = None,
        multilingual: bool = False,
        **whisper_kwargs,
    ) -> Dict:
        """Run Whisper and Pyannote in parallel, merge results."""
        print(f"\n{'='*60}")
        print(f"PARALLEL PROCESSING: {audio_path}")
        print(f"{'='*60}")

        start_time = time.time()

        # Prepare parameters for both tasks
        transcribe_options: Dict = {"word_timestamps": True, **whisper_kwargs}

        if multilingual:
            print("  → Multilingual mode enabled (code-switching detection)")
            transcribe_options["task"] = "transcribe"
        else:
            transcribe_options["language"] = language

        diarization_options: Dict = {}
        if num_speakers is not None:
            diarization_options["num_speakers"] = num_speakers
        elif min_speakers is not None or max_speakers is not None:
            diarization_options["min_speakers"] = min_speakers
            diarization_options["max_speakers"] = max_speakers

        # Run Whisper and Pyannote in parallel
        print("\nRunning Whisper and Pyannote in parallel...")
        print("  Launching parallel workers...")

        whisper_result: Optional[Dict] = None
        diarization_result: Optional[Annotation] = None
        whisper_time = 0.0
        diarization_time = 0.0

        executor = ThreadPoolExecutor(max_workers=2)
        try:
            # Submit both tasks
            whisper_future = executor.submit(
                self._run_whisper, audio_path, transcribe_options
            )
            diarization_future = executor.submit(
                self._run_diarization, audio_path, diarization_options
            )

            # Wait for completion and collect results
            for future in as_completed([whisper_future, diarization_future]):
                try:
                    if future is whisper_future:
                        whisper_result, whisper_time = future.result(timeout=None)
                        print(f"   Whisper completed ({whisper_time:.2f}s)")
                    else:
                        diarization_result, diarization_time = future.result(timeout=None)
                        print(f"   Pyannote completed ({diarization_time:.2f}s)")
                except KeyboardInterrupt:
                    print("\n\n Interrupted by user! Cancelling workers...")
                    whisper_future.cancel()
                    diarization_future.cancel()
                    executor.shutdown(wait=False, cancel_futures=True)
                    raise
                except Exception as e:
                    print(f"\nError in parallel worker: {e}")
                    whisper_future.cancel()
                    diarization_future.cancel()
                    executor.shutdown(wait=False, cancel_futures=True)
                    raise
        except KeyboardInterrupt:
            print("\n Transcription cancelled by user")
            raise
        finally:
            executor.shutdown(wait=True)

        if whisper_result is None or diarization_result is None:
            raise RuntimeError("Whisper or diarization result missing; parallel execution failed.")

        parallel_time = time.time() - start_time
        print(f"\n  Total parallel time: {parallel_time:.2f}s")
        print(
            f"  Time saved: {(whisper_time + diarization_time - parallel_time):.2f}s"
        )

        # Merge results deterministically
        print("\nMerging Whisper transcription with Pyannote speakers...")
        merge_start = time.time()

        result = self._merge_results(whisper_result, diarization_result)

        merge_time = time.time() - merge_start
        total_time = time.time() - start_time

        print(f"  Merge completed ({merge_time:.2f}s)")
        print(f"\nProcessing complete! Total time: {total_time:.2f}s")
        print(
            f"  Detected {len(result['speakers'])} speakers: {', '.join(result['speakers'])}"
        )

        # Add timing information
        result["timing"] = {
            "whisper_time": whisper_time,
            "diarization_time": diarization_time,
            "parallel_time": parallel_time,
            "merge_time": merge_time,
            "total_time": total_time,
            "time_saved": whisper_time + diarization_time - parallel_time,
        }

        return result

    def _run_whisper(
        self, audio_path: str, options: Dict
    ) -> Tuple[Dict, float]:
        """Run Whisper transcription (designed to run in parallel)."""
        print("  [Whisper] Starting transcription...")
        start_time = time.time()

        # Inference doesn't need gradients
        with torch.no_grad():
            result = self.whisper_model.transcribe(audio_path, **options)

        elapsed = time.time() - start_time
        return result, elapsed

    def _run_diarization(
        self, audio_path: str, options: Dict
    ) -> Tuple[Annotation, float]:
        """Run Pyannote diarization (designed to run in parallel)."""
        print("  [Pyannote] Starting speaker diarization...")
        start_time = time.time()

        result = self.diarization_pipeline(audio_path, **options)

        elapsed = time.time() - start_time
        return result, elapsed

    def _merge_results(
        self, whisper_result: Dict, diarization: Annotation
    ) -> Dict:
        """Merge Whisper and Pyannote results deterministically."""
        # Extract words with timestamps from Whisper result
        word_segments: List[Dict] = []

        for segment in whisper_result.get("segments", []):
            segment_language = segment.get("language", None)

            if "words" not in segment:
                # Fallback: if no word timestamps, use segment timestamps
                speaker = self._get_speaker_at_timestamp(
                    diarization, (segment["start"] + segment["end"]) / 2
                )
                word_segments.append(
                    {
                        "word": segment["text"],
                        "start": segment["start"],
                        "end": segment["end"],
                        "speaker": speaker,
                        "probability": segment.get("probability", 1.0),
                        "language": segment_language,
                    }
                )
            else:
                for word_info in segment["words"]:
                    # Get speaker at the middle of the word (deterministic alignment)
                    word_middle = (word_info["start"] + word_info["end"]) / 2
                    speaker = self._get_speaker_at_timestamp(diarization, word_middle)

                    word_segments.append(
                        {
                            "word": word_info["word"],
                            "start": word_info["start"],
                            "end": word_info["end"],
                            "speaker": speaker,
                            "probability": word_info.get("probability", 1.0),
                            "language": segment_language,
                        }
                    )

        # Group consecutive words by the same speaker into segments
        speaker_segments = self._group_by_speaker(word_segments)

        # Get unique speakers
        speakers = sorted(
            set(ws["speaker"] for ws in word_segments if ws["speaker"])
        )

        return {
            "text": whisper_result["text"],
            "segments": speaker_segments,
            "word_segments": word_segments,
            "language": whisper_result.get("language", "unknown"),
            "speakers": speakers,
        }

    def _get_speaker_at_timestamp(
        self, diarization: Annotation, timestamp: float
    ) -> Optional[str]:
        """Get speaker at a specific timestamp (deterministic)."""
        best_speaker = None
        best_dist = None

        for segment, _, speaker in diarization.itertracks(yield_label=True):
            if segment.start <= timestamp <= segment.end:
                center = (segment.start + segment.end) / 2.0
                dist = abs(center - timestamp)
                if best_dist is None or dist < best_dist:
                    best_dist = dist
                    best_speaker = speaker

        return best_speaker

    def _smart_join(self, prev_text: str, token: str) -> str:
        """Smart spacing around punctuation when joining tokens."""
        if not prev_text:
            return token

        # Punctuation that should not have space before them
        closing_punct = {",", ".", "!", "?", ":", ";", ")", "]", "}", "'"}
        # Punctuation that should not have space after them
        opening_punct = {"(", "[", "{", "'"}

        # No space before closing punctuation
        if token in closing_punct:
            return prev_text + token

        # No space after opening punctuation
        if prev_text[-1] in opening_punct:
            return prev_text + token

        # Apostrophes within words
        if token == "'" and prev_text and prev_text[-1].isalnum():
            return prev_text + token

        # Default: add a space
        return prev_text + " " + token

    def _group_by_speaker(self, word_segments: List[Dict]) -> List[Dict]:
        """Group consecutive words by the same speaker into segments."""
        if not word_segments:
            return []

        segments: List[Dict] = []
        current_segment = {
            "speaker": word_segments[0]["speaker"],
            "start": word_segments[0]["start"],
            "end": word_segments[0]["end"],
            "text": word_segments[0]["word"],
            "words": [word_segments[0]],
        }

        for word_info in word_segments[1:]:
            if word_info["speaker"] == current_segment["speaker"]:
                current_segment["text"] = self._smart_join(
                    current_segment["text"], word_info["word"]
                )
                current_segment["end"] = word_info["end"]
                current_segment["words"].append(word_info)
            else:
                segments.append(current_segment)
                current_segment = {
                    "speaker": word_info["speaker"],
                    "start": word_info["start"],
                    "end": word_info["end"],
                    "text": word_info["word"],
                    "words": [word_info],
                }

        segments.append(current_segment)
        return segments


def main():
    """Command-line interface for Parallel Whisper + Diarization"""
    parser = argparse.ArgumentParser(
        description="Parallel transcription with Whisper + Pyannote speaker diarization",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument("audio", type=str, help="Path to audio file")

    parser.add_argument(
        "--whisper-model",
        type=str,
        default="turbo",
        choices=["tiny", "base", "small", "medium", "large", "large-v2", "large-v3", "turbo"],
        help="Whisper model size",
    )
    parser.add_argument(
        "--diarization-model",
        type=str,
        default="pyannote/speaker-diarization-3.1",
        help="HuggingFace diarization model",
    )
    parser.add_argument(
        "--hf-token", type=str, default=None, help="HuggingFace token for pyannote models"
    )
    parser.add_argument(
        "--language",
        type=str,
        default=None,
        help="Language code (e.g., 'en', 'es', 'fr') or None for auto-detect",
    )
    parser.add_argument(
        "--num-speakers", type=int, default=None, help="Exact number of speakers (if known)"
    )
    parser.add_argument(
        "--min-speakers", type=int, default=None, help="Minimum number of speakers"
    )
    parser.add_argument(
        "--max-speakers", type=int, default=None, help="Maximum number of speakers"
    )
    parser.add_argument(
        "--multilingual",
        action="store_true",
        help="Enable multilingual/code-switching mode",
    )
    parser.add_argument(
        "--output", "-o", type=str, default=None, help="Output file path (JSON format)"
    )
    parser.add_argument(
        "--device",
        type=str,
        default=None,
        choices=["cuda", "cpu"],
        help="Device to use for inference",
    )

    args = parser.parse_args()

    if not os.path.exists(args.audio):
        print(f"Error: Audio file not found: {args.audio}")
        return

    # Initialize pipeline
    try:
        pipeline = ParallelWhisperDiarization(
            whisper_model=args.whisper_model,
            diarization_model=args.diarization_model,
            device=args.device,
            hf_token=args.hf_token,
        )
    except Exception as e:
        print(f"\nError initializing pipeline: {e}")
        return

    # Transcribe with parallel processing
    result = pipeline.transcribe(
        args.audio,
        language=args.language,
        num_speakers=args.num_speakers,
        min_speakers=args.min_speakers,
        max_speakers=args.max_speakers,
        multilingual=args.multilingual,
    )

    # Determine output path
    if args.output is None:
        audio_path = Path(args.audio)
        output_path = audio_path.parent / f"{audio_path.stem}_raw.json"
    else:
        output_path = Path(args.output)

    # Save raw results as JSON
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"\nSaved raw transcript: {output_path}")

    # Print summary
    print("\n" + "=" * 60)
    print("TRANSCRIPTION SUMMARY")
    print("=" * 60)
    print(f"Language: {result['language']}")
    print(f"Speakers detected: {len(result['speakers'])}")
    print(f"Speakers: {', '.join(result['speakers'])}")
    print(f"\nSegments: {len(result['segments'])}")

    # Print timing information
    if "timing" in result:
        timing = result["timing"]
        print(f"\n{'=' * 60}")
        print("PERFORMANCE METRICS")
        print(f"{'=' * 60}")
        print(f"Whisper time:       {timing['whisper_time']:.2f}s")
        print(f"Pyannote time:      {timing['diarization_time']:.2f}s")
        print(
            f"Sequential would:   {timing['whisper_time'] + timing['diarization_time']:.2f}s"
        )
        print(f"Parallel actual:    {timing['parallel_time']:.2f}s")
        print(
            f"Time saved:         {timing['time_saved']:.2f}s ({timing['time_saved']/(timing['whisper_time'] + timing['diarization_time'])*100:.1f}%)"
        )
        print(f"Merge time:         {timing['merge_time']:.2f}s")
        print(f"Total time:         {timing['total_time']:.2f}s")


if __name__ == "__main__":
    main()
