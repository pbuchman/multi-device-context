"""Reproduce committed native icons. Optional design tool: Python + Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parents[1] / 'resources'
image = Image.new('RGBA', (1024, 1024))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((40, 40, 984, 984), radius=224, fill='#326653')
for points in [[(240,320),(744,320)],[(640,216),(744,320),(640,424)],[(784,704),(280,704)],[(384,600),(280,704),(384,808)]]:
    draw.line(points, fill='white', width=64, joint='curve')
    for x,y in points: draw.ellipse((x-32,y-32,x+32,y+32),fill='white')
draw.line([(280,496),(744,496)],fill='#b8d7c9',width=48)
for x in [280,744]: draw.ellipse((x-24,472,x+24,520),fill='#b8d7c9')
image.save(root/'app.png')
image.save(root/'app.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
image.resize((64,64),Image.Resampling.LANCZOS).save(root/'tray.png')
for size,name in [(32,'trayTemplate.png'),(64,'trayTemplate@2x.png')]:
    tray=Image.new('RGBA',(128,128)); pen=ImageDraw.Draw(tray)
    for points in [[(20,42),(104,42),(84,22)],[(108,86),(24,86),(44,106)]]: pen.line(points,fill='black',width=12,joint='curve')
    tray.resize((size,size),Image.Resampling.LANCZOS).save(root/name)
