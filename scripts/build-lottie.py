# Builds the two Lottie animations in src/simple/lottie (checkmark, document scan).
# Usage: python3 scripts/build-lottie.py src/simple/lottie
import json,sys
def st(v): return {"a":0,"k":v}
def kf(frames, ease=(0.2,0,0.2,1)):
    out=[]
    for i,(t,v) in enumerate(frames):
        k={"t":t,"s":v if isinstance(v,list) else [v]}
        if i<len(frames)-1:
            k["o"]={"x":[ease[0]],"y":[ease[1]]}; k["i"]={"x":[ease[2]],"y":[ease[3]]}
        out.append(k)
    return {"a":1,"k":out}
def tr(p=(0,0),s=None,o=None):
    return {"ty":"tr","p":st(list(p)),"a":st([0,0]),"s":s or st([100,100]),"r":st(0),"o":o or st(100),"sk":st(0),"sa":st(0)}
def ks(p,s=None,o=None):
    return {"o":o or st(100),"r":st(0),"p":st([p[0],p[1],0]),"a":st([0,0,0]),"s":s or st([100,100,100])}
def layer(ind,name,shapes,op,p=(0,0),s=None,o=None):
    return {"ddd":0,"ind":ind,"ty":4,"nm":name,"sr":1,"ks":ks(p,s,o),"ao":0,"shapes":shapes,"ip":0,"op":op,"st":0,"bm":0}
def path(pts,closed=False):
    z=[[0,0]]*len(pts)
    return {"ty":"sh","ks":st({"i":z,"o":z,"v":[list(p) for p in pts],"c":closed})}
def stroke(c,w,o=None): return {"ty":"st","c":c if isinstance(c,dict) else st(c),"o":o or st(100),"w":st(w),"lc":2,"lj":2,"ml":4}
def fill(c): return {"ty":"fl","c":st(c),"o":st(100),"r":1}
INK=[0.055,0.059,0.071,1]; VOLT=[0.776,0.957,0.196,1]; GREY=[0.812,0.812,0.773,1]; WHITE=[1,1,1,1]; PAPER=[0.957,0.957,0.937,1]
anim=lambda nm,w,h,op,layers:{"v":"5.7.4","fr":60,"ip":0,"op":op,"w":w,"h":h,"nm":nm,"ddd":0,"assets":[],"layers":layers}
# checkmark: ink disc pops, volt tick draws
OUT=lambda: (0.2,0,0.2,1)
check=anim("check",48,48,40,[
  layer(1,"tick",[{"ty":"gr","it":[path([(15,25),(21,31),(33,18)]),stroke(VOLT,4.2),{"ty":"tm","s":st(0),"e":kf([(8,0),(24,100)],(0.3,0,0.2,1)),"o":st(0),"m":1},tr()]}],40),
  layer(2,"disc",[{"ty":"gr","it":[{"ty":"el","p":st([0,0]),"s":st([40,40])},fill(INK),tr()]}],40,p=(24,24),
        s=kf([(0,[0,0,100]),(10,[112,112,100]),(18,[100,100,100])],(0.2,0.8,0.2,1))),
])
# doc scan, 96x96, loops every 150 frames
op=150
page={"ty":"gr","it":[{"ty":"rc","p":st([48,48]),"s":st([56,70]),"r":st(8)},fill(WHITE),stroke(INK,3),tr()]}
lines=[]
ys=[30,40,50,60]; xs=[(31,65),(31,65),(31,65),(31,54)]
passT=[14,24,34,44]
for (y,(a,b)),t in zip(zip(ys,xs),passT):
    col=kf([(t,GREY),(t+6,INK),(104,INK),(116,GREY)])
    lines.append({"ty":"gr","it":[path([(a,y),(b,y)]),stroke(col,4),tr()]})
bar={"ty":"gr","it":[{"ty":"rc","p":st([0,0]),"s":st([70,7]),"r":st(3.5)},fill(VOLT),stroke(INK,1.5),tr()]}
scan=anim("scan",96,96,op,[
  layer(1,"bar",[bar],op,p=(48,20),
        o=kf([(0,0),(8,100),(62,100),(74,0),(150,0)])),
  layer(2,"lines",lines,op),
  layer(3,"page",[page],op),
])
# bar position animated separately: patch ks.p
scan["layers"][0]["ks"]["p"]=kf([(0,[48,20,0]),(62,[48,76,0]),(74,[48,76,0]),(75,[48,20,0])],(0.45,0,0.35,1))
json.dump(check,open(sys.argv[1]+"/check.json","w"),separators=(",",":"))
json.dump(scan,open(sys.argv[1]+"/scan.json","w"),separators=(",",":"))
