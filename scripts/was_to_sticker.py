#!/usr/bin/env python3

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile


MAX_SECONDS = 3.0
MAX_FRAMES = 90


def fail(message):
    print(message, file=sys.stderr)
    return 1


def run(command):
    return subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        return fail("Input .was file not found")

    work = tempfile.mkdtemp(prefix="was-sticker-")

    try:
        with zipfile.ZipFile(args.input, "r") as archive:
            names = archive.namelist()
            json_name = next(
                (
                    name for name in names
                    if name.lower() == "animation/animation.json"
                ),
                next(
                    (
                        name for name in names
                        if name.lower().endswith("animation.json")
                    ),
                    None,
                ),
            )

            if not json_name:
                return fail("This .was file does not contain animation/animation.json")

            lottie_json = os.path.join(work, "animation.json")
            with archive.open(json_name) as source, open(lottie_json, "wb") as destination:
                shutil.copyfileobj(source, destination)

        with open(lottie_json, "r", encoding="utf-8") as fh:
            animation = json.load(fh)

        fps = float(animation.get("fr", 30) or 30)
        start_frame = float(animation.get("ip", 0) or 0)
        end_frame = float(animation.get("op", 0) or 0)

        if fps <= 0:
            fps = 30.0

        total_frames = max(1, int(round(end_frame - start_frame)))
        frame_count = min(total_frames, MAX_FRAMES, max(1, int(MAX_SECONDS * fps)))

        if total_frames > frame_count:
            fps = frame_count / MAX_SECONDS

        converter = shutil.which("lottie_convert.py")
        if not converter:
            return fail("lottie_convert.py was not found")

        cairosvg_check = run(
            [sys.executable, "-c", "import cairosvg"]
        )
        if cairosvg_check.returncode != 0:
            return fail(
                "CairoSVG is required. Run: python -m pip install CairoSVG"
            )

        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            return fail("ffmpeg was not found. Run: pkg install ffmpeg")

        encoder_check = run([ffmpeg, "-hide_banner", "-encoders"])
        if "libwebp_anim" not in encoder_check.stdout:
            return fail("ffmpeg libwebp_anim encoder is unavailable")

        frame_dir = os.path.join(work, "frames")
        os.makedirs(frame_dir, exist_ok=True)

        print(
            f"[STICKER] Rendering {frame_count} frames at {fps:.2f} fps...",
            file=sys.stderr,
        )

        for index in range(frame_count):
            frame_number = int(start_frame + (index * total_frames / frame_count))
            svg_path = os.path.join(work, f"frame-{index:05d}.svg")
            png_path = os.path.join(frame_dir, f"frame-{index:05d}.png")

            result = run(
                [
                    converter,
                    lottie_json,
                    svg_path,
                    "--output-format", "svg",
                    "--frame", str(frame_number),
                    "--width", "512",
                    "--height", "512",
                ]
            )
            if result.returncode != 0:
                return fail(
                    f"Lottie frame {index} failed: "
                    + (result.stderr or result.stdout or "unknown error").strip()[-3000:]
                )

            try:
                import cairosvg
                cairosvg.svg2png(
                    url=svg_path,
                    write_to=png_path,
                    output_width=512,
                    output_height=512,
                )
            except Exception as error:
                return fail(f"SVG frame {index} -> PNG failed: {error}")

        output_dir = os.path.dirname(os.path.abspath(args.output))
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)

        print("[STICKER] Encoding animated WebP with ffmpeg...", file=sys.stderr)

        # Try progressively stronger compression. WhatsApp animated stickers
        # should remain small enough to send reliably.
        qualities = (65, 50, 35, 25)
        last_error = ""

        for quality in qualities:
            result = run(
                [
                    ffmpeg,
                    "-y",
                    "-hide_banner",
                    "-loglevel", "error",
                    "-framerate", f"{fps:.6f}",
                    "-i", os.path.join(frame_dir, "frame-%05d.png"),
                    "-c:v", "libwebp_anim",
                    "-lossless", "0",
                    "-q:v", str(quality),
                    "-compression_level", "6",
                    "-loop", "0",
                    "-an",
                    args.output,
                ]
            )

            if result.returncode != 0:
                last_error = result.stderr or result.stdout or "ffmpeg failed"
                continue

            if os.path.isfile(args.output):
                size = os.path.getsize(args.output)
                if size > 0 and size <= 1024 * 1024:
                    print(f"OK {size}")
                    return 0

                last_error = f"Generated WebP is {size} bytes"
                try:
                    os.remove(args.output)
                except OSError:
                    pass

        return fail(
            "Could not produce a WhatsApp-sized animated WebP. "
            + last_error[-3000:]
        )

    except zipfile.BadZipFile:
        return fail("The supplied .was file is not a valid WAS/Lottie archive")
    except Exception as error:
        return fail(f"Sticker conversion failed: {error}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
