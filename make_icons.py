"""Genera los iconos PNG de la galería. Uso: python3 make_icons.py (necesita Pillow)."""
from PIL import Image, ImageDraw

INK = (14, 16, 19)
BONE = (236, 239, 244)
PANEL = (31, 35, 41)
BACK = (58, 65, 76)
AMBER = (245, 181, 68)

def make(size, kind):
    S = size * 4
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if kind == 'any':
        d.rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.219), fill=INK)
        k = 1.0
    else:
        d.rectangle((0, 0, S, S), fill=INK)
        k = 0.8          # contenido dentro de la zona segura del icono adaptable
    def P(x, y):          # coordenadas del diseño base (512) -> píxeles
        return (S / 2 + (x - 256) * k * S / 512, S / 2 + (y - 256) * k * S / 512)
    def L(v):
        return v * k * S / 512
    # tarjeta de atrás
    x0, y0 = P(140, 82); x1, y1 = P(396, 338)
    d.rounded_rectangle((x0, y0, x1, y1), radius=L(40), outline=BACK, width=max(2, int(L(14))))
    # marco principal
    x0, y0 = P(92, 130); x1, y1 = P(388, 426)
    d.rounded_rectangle((x0, y0, x1, y1), radius=L(46), fill=PANEL, outline=BONE, width=max(2, int(L(18))))
    # montañas y sol
    d.polygon([P(110, 380), P(204, 262), P(262, 330), P(318, 252), P(370, 380)], fill=AMBER)
    cx, cy = P(322, 198); r = L(26)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=BONE)
    return img.resize((size, size), Image.LANCZOS)

make(192, 'any').save('icons/icon-192.png')
make(512, 'any').save('icons/icon-512.png')
make(192, 'maskable').save('icons/maskable-192.png')
make(512, 'maskable').save('icons/maskable-512.png')
make(180, 'maskable').convert('RGB').save('icons/apple-touch-icon.png')
make(32, 'any').save('icons/favicon-32.png')
print('Iconos generados')
