from PIL import Image, ImageDraw, ImageFilter
import math, random

S=1024
img=Image.new('RGBA',(S,S),(0,0,0,0))
d=ImageDraw.Draw(img)

# rounded dark green background with radial gradient
bg=Image.new('RGBA',(S,S),(0,0,0,0))
bd=ImageDraw.Draw(bg)
for y in range(S):
    for step in range(1):
        pass
# gradient via resize of a small image
small=Image.new('RGB',(64,64))
sp=small.load()
for y in range(64):
    for x in range(64):
        dx=(x-32)/32; dy=(y-32)/32
        r=min(1,math.sqrt(dx*dx+dy*dy))
        sp[x,y]=(int(10+16*(1-r)), int(34+46*(1-r)), int(22+26*(1-r)))
bg=small.resize((S,S), Image.BICUBIC).convert('RGBA')
mask=Image.new('L',(S,S),0)
ImageDraw.Draw(mask).rounded_rectangle([0,0,S-1,S-1],radius=150,fill=255)
img.paste(bg,(0,0),mask)
d=ImageDraw.Draw(img)

# grid lines
grid=Image.new('RGBA',(S,S),(0,0,0,0))
gd=ImageDraw.Draw(grid)
for i in range(0,S,96):
    gd.line([(i,0),(i,S)],fill=(126,217,87,18),width=2)
    gd.line([(0,i),(S,i)],fill=(126,217,87,18),width=2)
img=Image.alpha_composite(img,grid)
d=ImageDraw.Draw(img)

cx,cy=512,470
petal_r=190
petals=14
for i in range(petals):
    ang=2*math.pi*i/petals - math.pi/2
    px=cx+math.cos(ang)*petal_r
    py=cy+math.sin(ang)*petal_r
    a,b=95,58
    pts=[]
    for k in range(48):
        t=2*math.pi*k/48
        ex=a*math.cos(t); ey=b*math.sin(t)
        # rotate petal so long axis points outward
        rx=ex*math.cos(ang)-ey*math.sin(ang)
        ry=ex*math.sin(ang)+ey*math.cos(ang)
        pts.append((px+rx,py+ry))
    d.polygon(pts,fill=(255,206,64,255),outline=(196,132,20,255))

# petal highlights
for i in range(petals):
    ang=2*math.pi*i/petals - math.pi/2
    px=cx+math.cos(ang)*petal_r
    py=cy+math.sin(ang)*petal_r
    d.ellipse([px-36,py-24,px+8,py+2],fill=(255,235,140,120))

# outer glow ring
ring=Image.new('RGBA',(S,S),(0,0,0,0))
rd=ImageDraw.Draw(ring)
rd.ellipse([cx-265,cy-265,cx+265,cy+265],outline=(126,217,87,160),width=8)
ring=ring.filter(ImageFilter.GaussianBlur(6))
img=Image.alpha_composite(img,ring)
d=ImageDraw.Draw(img)

# face center
d.ellipse([cx-178,cy-178,cx+178,cy+178],fill=(120,74,36,255),outline=(78,44,18,255),width=10)
d.ellipse([cx-150,cy-150,cx+150,cy+150],fill=(146,92,45,255))
# seed texture
random.seed(7)
for _ in range(260):
    a=random.random()*2*math.pi; r=random.random()**0.5*140
    x=cx+math.cos(a)*r; y=cy+math.sin(a)*r
    rr=random.randint(2,5)
    d.ellipse([x-rr,y-rr,x+rr,y+rr],fill=(98,58,26,180))

# eyes
for sx in (-1,1):
    ex=cx+sx*62; ey=cy-34
    d.ellipse([ex-34,ey-42,ex+34,ey+42],fill=(255,255,250,255),outline=(70,40,18,255),width=5)
    d.ellipse([ex-15+sx*4,ey-16,ex+15+sx*4,ey+22],fill=(39,58,40,255))
    d.ellipse([ex-4+sx*4,ey-9,ex+6+sx*4,ey+1],fill=(255,255,255,255))
# smile
d.arc([cx-70,cy+18,cx+70,cy+118],start=18,end=162,fill=(62,34,14,255),width=10)
# cheeks
for sx in (-1,1):
    ex=cx+sx*138; ey=cy+58
    d.ellipse([ex-22,ey-12,ex+22,ey+12],fill=(214,110,70,110))

# circuit traces from center outward
trace=Image.new('RGBA',(S,S),(0,0,0,0))
td=ImageDraw.Draw(trace)
for i in range(4):
    ang=math.pi/4 + i*math.pi/2
    x1=cx+math.cos(ang)*80; y1=cy+math.sin(ang)*80
    x2=cx+math.cos(ang)*300; y2=cy+math.sin(ang)*300
    td.line([(x1,y1),(x2,y2)],fill=(126,255,180,150),width=5)
    td.ellipse([x2-12,y2-12,x2+12,y2+12],fill=(126,255,180,200))
trace=trace.filter(ImageFilter.GaussianBlur(2))
img=Image.alpha_composite(img,trace)

# chip badge bottom-right
bx,by=770,790
d=ImageDraw.Draw(img)
d.rounded_rectangle([bx-92,by-92,bx+92,by+92],radius=26,fill=(12,32,22,245),outline=(126,217,87,255),width=6)
for i in range(-2,3):
    d.line([(bx+i*30,by-92),(bx+i*30,by-112)],fill=(126,217,87,220),width=6)
    d.line([(bx+i*30,by+92),(bx+i*30,by+112)],fill=(126,217,87,220),width=6)
    d.line([(bx-92,by+i*30),(bx-112,by+i*30)],fill=(126,217,87,220),width=6)
    d.line([(bx+92,by+i*30),(bx+112,by+i*30)],fill=(126,217,87,220),width=6)
# simple brain/leaf glyph in chip
d.ellipse([bx-38,by-38,bx+38,by+38],fill=(126,217,87,255))
d.ellipse([bx-24,by-26,bx-2,by+2],fill=(14,40,24,255))
d.ellipse([bx+2,by-26,bx+24,by+2],fill=(14,40,24,255))
d.arc([bx-26,by+2,bx+26,by+38],start=20,end=160,fill=(14,40,24,255),width=7)

# subtle vignette
vig=Image.new('RGBA',(S,S),(0,0,0,0))
vd=ImageDraw.Draw(vig)
vd.ellipse([-300,-300,S+300,S+300],outline=(0,0,0,90),width=400)
vig=vig.filter(ImageFilter.GaussianBlur(120))
img=Image.alpha_composite(img,vig)

# rounded crop + resize
out=Image.new('RGBA',(S,S),(0,0,0,0))
out.paste(img,(0,0),mask)
out=out.resize((512,512),Image.LANCZOS)
out.save('pvz-ai-agent-mod/thumbnail.png')
print('saved', out.size)
