"""把新的品牌图标替换到扩展的各尺寸图标文件。

## 关键坑（踩过一次）

源图 PNG 在圆角方形之外还有一层极淡的半透明边缘（alpha 1~16，可能是导出时的
阴影/抗锯齿残留）。如果用 `alpha > 0` 求包围盒，会把这点淡边也算进去：

    源图 1254x1254，alpha>0   包围盒 = 1246x1229  → 图案只占画布 77%
                              （结果是工具栏里图标比别人的小一圈）
    源图 1254x1254，alpha>16  包围盒 =  970x991   ← 这才是图标本体

所以这里用 **alpha 阈值**求包围盒，再把图案填满画布的 95%——
留 5% 是给抗锯齿和圆角边缘的余量，再多就会显得比同类扩展小。
"""

from pathlib import Path
from PIL import Image

SRC = Path(
    r"C:\Users\Nameless\.dsh\attachments\v1\objects\c2"
    r"\c2c879f8927cf7cbe01c5f15850507d021385fe2eed6fd6575859131c4df8039"
)
REPO = Path(r"E:\Project\bilibiliMemory\bilibili-memory")
ICON_DIR = REPO / "public" / "icon"
BRAND_ASSETS = REPO / "branding" / "assets"

# 忽略 alpha <= 该值的像素（淡边/阴影），只按真实图案取包围盒
ALPHA_THRESHOLD = 16
# 图案占画布的目标比例。95% 与常见扩展图标（如 AdGuard）的视觉重量相当
FILL_RATIO = 0.95


def content_bbox(img: Image.Image, threshold: int = ALPHA_THRESHOLD):
    alpha = img.convert("RGBA").split()[-1]
    mask = alpha.point(lambda v: 255 if v > threshold else 0)
    return mask.getbbox()


def main() -> None:
    img = Image.open(SRC).convert("RGBA")
    print(f"源图: {img.size}")

    raw_bbox = img.split()[-1].getbbox()
    box = content_bbox(img)
    print(f"alpha>0  包围盒: {raw_bbox}")
    print(f"alpha>{ALPHA_THRESHOLD} 包围盒: {box} = {box[2] - box[0]}x{box[3] - box[1]}")

    icon = img.crop(box)

    # 补成正方形（透明填充），避免缩放时被压扁
    side = max(icon.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(icon, ((side - icon.size[0]) // 2, (side - icon.size[1]) // 2))

    ICON_DIR.mkdir(parents=True, exist_ok=True)
    BRAND_ASSETS.mkdir(parents=True, exist_ok=True)

    print("\n=== 生成图标 ===")
    for size in (16, 32, 48, 96, 128):
        inner = max(1, round(size * FILL_RATIO))
        scaled = square.resize((inner, inner), Image.LANCZOS)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        offset = (size - inner) // 2
        canvas.paste(scaled, (offset, offset), scaled)
        path = ICON_DIR / f"{size}.png"
        canvas.save(path, optimize=True)

        # 校验：真实图案应当接近 FILL_RATIO
        bb = content_bbox(canvas, 128)
        ratio = (bb[2] - bb[0]) / size if bb else 0
        print(f"  {path.name}: {size}x{size}  图案占比 {ratio * 100:.0f}%  {path.stat().st_size} B")

    square.resize((512, 512), Image.LANCZOS).save(
        BRAND_ASSETS / "icon-512.png", optimize=True
    )
    square.save(BRAND_ASSETS / "icon-source.png")
    print(f"\n已更新 {BRAND_ASSETS / 'icon-512.png'}")
    print(f"已更新 {BRAND_ASSETS / 'icon-source.png'} ({square.size})")


if __name__ == "__main__":
    main()
