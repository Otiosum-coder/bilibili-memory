"""生成浏览器商店需要的大尺寸商店图标（Edge 要求 300×300）。

复用了扩展图标的同一套裁切规则，保证商店页与工具栏看到的是同一个 logo：
- 按 alpha>16 求真实图案包围盒（源图有一层极淡的半透明边缘，见 replace-icon.py）
- 补成正方形后缩放到 95% 填充，留 5% 给抗锯齿
- 保留透明通道，四角透明

输出到仓库之外的 store-assets/，避免把提交素材混进 git。
"""

from pathlib import Path
from PIL import Image

SRC = Path(
    r"C:\Users\Nameless\.dsh\attachments\v1\objects\c2"
    r"\c2c879f8927cf7cbe01c5f15850507d021385fe2eed6fd6575859131c4df8039"
)
OUT_DIR = Path(r"E:\Project\bilibiliMemory\store-assets")

ALPHA_THRESHOLD = 16
FILL_RATIO = 0.95


def content_bbox(img: Image.Image, threshold: int = ALPHA_THRESHOLD):
    alpha = img.convert("RGBA").split()[-1]
    mask = alpha.point(lambda v: 255 if v > threshold else 0)
    return mask.getbbox()


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"找不到源图: {SRC}")

    img = Image.open(SRC).convert("RGBA")
    box = content_bbox(img)
    icon = img.crop(box)
    side = max(icon.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(icon, ((side - icon.size[0]) // 2, (side - icon.size[1]) // 2))
    print(f"源图 {img.size} → 图案 {box[2] - box[0]}x{box[3] - box[1]} → 方形 {square.size}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for size, name in [
        (300, "edge-store-logo-300.png"),
        (512, "store-icon-512.png"),
        (128, "store-icon-128.png"),
    ]:
        inner = round(size * FILL_RATIO)
        scaled = square.resize((inner, inner), Image.LANCZOS)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        off = (size - inner) // 2
        canvas.paste(scaled, (off, off), scaled)
        path = OUT_DIR / name
        canvas.save(path, optimize=True)
        alpha_min, alpha_max = canvas.split()[-1].getextrema()
        print(
            f"  {name}: {canvas.size[0]}x{canvas.size[1]}  "
            f"alpha={alpha_min}..{alpha_max}  {path.stat().st_size / 1024:.1f} KB"
        )

    print(f"\n输出目录: {OUT_DIR}")


if __name__ == "__main__":
    main()
