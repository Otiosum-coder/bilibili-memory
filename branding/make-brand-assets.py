"""从品牌源图切出图标与艺术字，生成扩展所需的各尺寸图标。

源图是白底品牌图：左边圆角方形图标、右边艺术字 + 标语。
不能硬编码分隔线（第一次试过，切歪了），改为按"列的空白间隔"自动把两者分开。
"""

from pathlib import Path
from PIL import Image

SRC = Path(
    r"C:\Users\Nameless\.dsh\attachments\v1\objects\db"
    r"\dbeea2cfa1e4749697932983d0bae2cffd5bbb1e6b3b29bd91d83168f2d2b55d"
)
OUT = Path(r"E:\Project\bilibiliMemory\bilibili-memory\branding\assets")
ICON_DIR = Path(r"E:\Project\bilibiliMemory\bilibili-memory\public\icon")

WHITE = 245          # 三通道都 >= 该值视为背景
GAP_TOLERANCE = 12   # 列间隔小于该值视为同一块（合并文字笔画间的空隙）


def column_has_ink(px, width, height, x) -> bool:
    for y in range(height):
        r, g, b = px[x, y][:3]
        if not (r >= WHITE and g >= WHITE and b >= WHITE):
            return True
    return False


def vertical_runs(px, width, height):
    """返回 [(x_start, x_end)] 的非空白列区块，已合并 <= GAP_TOLERANCE 的小间隔。"""
    flags = [column_has_ink(px, width, height, x) for x in range(width)]
    runs = []
    start = None
    for x, has in enumerate(flags):
        if has and start is None:
            start = x
        elif not has and start is not None:
            runs.append((start, x))
            start = None
    if start is not None:
        runs.append((start, width))

    merged = []
    for run in runs:
        if merged and run[0] - merged[-1][1] <= GAP_TOLERANCE:
            merged[-1] = (merged[-1][0], run[1])
        else:
            merged.append(list(run))
    return [(a, b) for a, b in merged]


def row_bounds(px, width, height, x0, x1):
    top, bottom = height, 0
    for y in range(height):
        for x in range(x0, x1):
            r, g, b = px[x, y][:3][:3]
            if not (r >= WHITE and g >= WHITE and b >= WHITE):
                if y < top:
                    top = y
                bottom = y
                break
    return top, bottom + 1


def square_pad(img: Image.Image, pad_ratio: float = 0.05) -> Image.Image:
    w, h = img.size
    side = max(w, h)
    pad = max(1, int(side * pad_ratio))
    canvas = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2 + pad, (side - h) // 2 + pad), img)
    return canvas


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    ICON_DIR.mkdir(parents=True, exist_ok=True)

    src = Image.open(SRC).convert("RGBA")
    width, height = src.size
    px = src.load()
    print(f"source: {width}x{height}")

    runs = vertical_runs(px, width, height)
    print(f"column runs: {runs}")
    if len(runs) < 2:
        raise SystemExit("could not separate icon from wordmark; inspect manually")

    # 最左一块是图标，最右一块是艺术字
    icon_l, icon_r = runs[0]
    word_l, word_r = runs[-1]
    icon_t, icon_b = row_bounds(px, width, height, icon_l, icon_r)
    word_t, word_b = row_bounds(px, width, height, word_l, word_r)
    print(f"icon bbox: ({icon_l},{icon_t},{icon_r},{icon_b}) "
          f"= {icon_r - icon_l}x{icon_b - icon_t}")
    print(f"wordmark bbox: ({word_l},{word_t},{word_r},{word_b}) "
          f"= {word_r - word_l}x{word_b - word_t}")

    icon = src.crop((icon_l, icon_t, icon_r, icon_b))
    icon_sq = square_pad(icon)
    icon_sq.save(OUT / "icon-source.png")

    for size in (16, 32, 48, 96, 128):
        icon_sq.resize((size, size), Image.LANCZOS).save(
            ICON_DIR / f"{size}.png", optimize=True
        )
        print(f"  wrote public/icon/{size}.png")
    icon_sq.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png", optimize=True)

    wordmark = src.crop((word_l, word_t, word_r, word_b))
    wordmark.save(OUT / "wordmark.png")
    print(f"wordmark: {wordmark.size}")

    # 完整 lockup：图标与艺术字按原图相对位置并排，垂直居中
    lock_h = max(icon_b - icon_t, word_b - word_t)
    pad_v = int(lock_h * 0.10)
    gap = max(8, int((word_l - icon_r) * 1.0))
    icon_h = icon_b - icon_t
    word_h = word_b - word_t
    total_w = (icon_r - icon_l) + gap + (word_r - word_l) + pad_v * 2
    total_h = lock_h + pad_v * 2
    canvas = Image.new("RGBA", (total_w, total_h), (0, 0, 0, 0))
    canvas.paste(icon, (pad_v, pad_v + (lock_h - icon_h) // 2), icon)
    canvas.paste(
        wordmark,
        (pad_v + (icon_r - icon_l) + gap, pad_v + (lock_h - word_h) // 2),
        wordmark,
    )
    canvas.save(OUT / "lockup-full.png")

    # 只有压缩后的 lockup 进 public/：它会被打进扩展包，体积要克制。
    # 840px 宽足够 420 CSS px 在 2x 屏上清晰，原图 1157px 是浪费。
    SHIP = Path(r"E:\Project\bilibiliMemory\bilibili-memory\public\brand")
    SHIP.mkdir(parents=True, exist_ok=True)
    ratio = 840 / canvas.size[0]
    shipped = canvas.resize((840, int(canvas.size[1] * ratio)), Image.LANCZOS)
    shipped.save(SHIP / "lockup.png", optimize=True)
    print(f"shipped lockup: {shipped.size}")
    print(f"lockup: {canvas.size}")


if __name__ == "__main__":
    main()
