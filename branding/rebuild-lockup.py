"""用新的透明底图标 + 已有的艺术字，重新拼装品牌 lockup。

为什么需要重拼：README、关于页、欢迎页用的 lockup 是上一版拼的，
里面嵌的图标是旧的（白底版）。图标已替换成新的透明底版，
不重拼就会出现"侧边栏图标"和"关于页 lockup 图标"两个样子。
"""

from pathlib import Path
from PIL import Image

REPO = Path(r"E:\Project\bilibiliMemory\bilibili-memory")
ASSETS = REPO / "branding" / "assets"
SHIP = REPO / "public" / "brand"

# 原 lockup 里图标高度 : 艺术字高度 ≈ 337 : 218
ICON_VS_WORD = 337 / 218
GAP_VS_ICON = 38 / 340          # 图标与艺术字之间的间距比例
PAD_RATIO = 0.10                # 上下留白占整体高度的比例
SHIP_WIDTH = 840                # 打包进扩展的宽度（420 CSS px 的 2x）


def main() -> None:
    icon = Image.open(ASSETS / "icon-source.png").convert("RGBA")
    word = Image.open(ASSETS / "wordmark.png").convert("RGBA")
    print(f"icon: {icon.size}   wordmark: {word.size}")

    word_h = word.size[1]
    icon_h = int(word_h * ICON_VS_WORD)
    icon_w = int(icon.size[0] * icon_h / icon.size[1])
    icon_scaled = icon.resize((icon_w, icon_h), Image.LANCZOS)
    gap = int(icon_w * GAP_VS_ICON)

    content_h = max(icon_h, word_h)
    pad = int(content_h * PAD_RATIO)
    total_w = icon_w + gap + word.size[0] + pad * 2
    total_h = content_h + pad * 2

    canvas = Image.new("RGBA", (total_w, total_h), (0, 0, 0, 0))
    canvas.paste(icon_scaled, (pad, pad + (content_h - icon_h) // 2), icon_scaled)
    canvas.paste(
        word,
        (pad + icon_w + gap, pad + (content_h - word_h) // 2),
        word,
    )
    canvas.save(ASSETS / "lockup-full.png")
    print(f"lockup-full: {canvas.size}")

    SHIP.mkdir(parents=True, exist_ok=True)
    ratio = SHIP_WIDTH / canvas.size[0]
    shipped = canvas.resize((SHIP_WIDTH, int(canvas.size[1] * ratio)), Image.LANCZOS)
    shipped.save(SHIP / "lockup.png", optimize=True)
    print(f"shipped lockup: {shipped.size}  {(SHIP / 'lockup.png').stat().st_size} B")


if __name__ == "__main__":
    main()
