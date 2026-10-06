#!/usr/bin/env python3

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile


def fail(message):
    print(message, file=sys.stderr)
    return 1


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

        output_dir = os.path.dirname(os.path.abspath(args.output))
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)

        converter = shutil.which("lottie_convert.py")
        if not converter:
            return fail("lottie_convert.py was not found. Run: python -m pip install 'lottie[GIF]'")

        command = [
            converter, lottie_json, args.output,
            "--width", "512", "--height", "512",
            "--fps", "30", "--webp-quality", "70",
        ]

        print("[STICKER] Rendering Lottie animation...", file=sys.stderr)
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        if result.returncode != 0:
            return fail((result.stderr or result.stdout or "Lottie conversion failed").strip()[-6000:])

        if not os.path.isfile(args.output):
            return fail("Lottie converter finished but no WebP was created")

        size = os.path.getsize(args.output)
        if size <= 0:
            return fail("Generated WebP is empty")

        print(f"OK {size}")
        return 0

    except zipfile.BadZipFile:
        return fail("The supplied .was file is not a valid WAS/Lottie archive")
    except Exception as error:
        return fail(f"Sticker conversion failed: {error}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
