import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';

const SAVE_KEY='nightshift-sector13-v1';
let save=JSON.parse(localStorage.getItem(SAVE_KEY)||'null')||{breakers:0,deaths:0,best:null,escaped:false,volume:.72};
const saveNow=()=>localStorage.setItem(SAVE_KEY,JSON.stringify(save));
const $=s=>document.querySelector(s);
const gameEl=$('#game'), objective=$('#objective'), status=$('#status'), prompt=$('#centerPrompt'), msg=$('#message'), danger=$('#danger');
const mobile = matchMedia('(pointer:coarse)').matches || innerWidth<800;

let scene,camera,renderer,clock,flashlight,monster,exitDoor;
let started=false,dead=false,won=false,paused=false,flashOn=true,sprinting=false;
let yaw=0,pitch=0,startTime=0,elapsed=0;
const player={pos:new THREE.Vector3(0,1.65,15),vel:new THREE.Vector3(),radius:.42,stamina:1};
const keys={}, colliders=[], breakerObjs=[], monsterWaypoints=[];
let monsterTarget=0, monsterState='patrol', monsterSeenTimer=0, monsterSpeed=1.65;
const interactables=[];

// --- rich procedural audio: low drones + filtered room noise + footsteps/chase layers ---
let ac,master,droneGain,noiseGain,heartbeatGain,humOsc,heartbeatTimer=0,lastStep=0,audioStarted=false;
function initAudio(){
  if(audioStarted)return; audioStarted=true;
  ac=new (window.AudioContext||window.webkitAudioContext)();
  master=ac.createGain(); master.gain.value=save.volume; master.connect(ac.destination);
  const low=ac.createBiquadFilter(); low.type='lowpass'; low.frequency.value=170;
  droneGain=ac.createGain(); droneGain.gain.value=.12; droneGain.connect(low).connect(master);
  [43.65,55,65.41].forEach((f,i)=>{const o=ac.createOscillator();const g=ac.createGain();o.type=i===1?'sine':'triangle';o.frequency.value=f;g.gain.value=[.22,.12,.07][i];o.connect(g).connect(droneGain);o.start();});
  const buf=ac.createBuffer(1,ac.sampleRate*4,ac.sampleRate),data=buf.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*.55;
  const n=ac.createBufferSource();n.buffer=buf;n.loop=true;const nf=ac.createBiquadFilter();nf.type='bandpass';nf.frequency.value=420;nf.Q.value=.45;noiseGain=ac.createGain();noiseGain.gain.value=.09;n.connect(nf).connect(noiseGain).connect(master);n.start();
  const hum=ac.createOscillator();const hg=ac.createGain();hum.type='sine';hum.frequency.value=60;hg.gain.value=.025;hum.connect(hg).connect(master);hum.start();humOsc=hum;
  heartbeatGain=ac.createGain();heartbeatGain.gain.value=0;heartbeatGain.connect(master);
}
function thump(intensity=.5){if(!ac)return; const now=ac.currentTime; const o=ac.createOscillator(),g=ac.createGain(),f=ac.createBiquadFilter();o.type='sine';o.frequency.setValueAtTime(72,now);o.frequency.exponentialRampToValueAtTime(42,now+.13);g.gain.setValueAtTime(.0001,now);g.gain.exponentialRampToValueAtTime(.18*intensity,now+.012);g.gain.exponentialRampToValueAtTime(.0001,now+.18);f.type='lowpass';f.frequency.value=180;o.connect(f).connect(g).connect(master);o.start(now);o.stop(now+.2)}
function metalHit(){if(!ac)return;const now=ac.currentTime;[160,233,347].forEach((f,i)=>{const o=ac.createOscillator(),g=ac.createGain();o.type='triangle';o.frequency.value=f;g.gain.setValueAtTime(.08/(i+1),now);g.gain.exponentialRampToValueAtTime(.0001,now+.7+i*.25);o.connect(g).connect(master);o.start();o.stop(now+1.5)});}
function footstep(){if(!ac)return;const now=ac.currentTime;const o=ac.createOscillator(),g=ac.createGain();o.type='sine';o.frequency.setValueAtTime(95,now);o.frequency.exponentialRampToValueAtTime(48,now+.08);g.gain.setValueAtTime(.05,now);g.gain.exponentialRampToValueAtTime(.0001,now+.11);o.connect(g).connect(master);o.start();o.stop(now+.12)}
function scareSound(){if(!ac)return;const now=ac.currentTime;const o=ac.createOscillator(),g=ac.createGain();o.type='sawtooth';o.frequency.setValueAtTime(95,now);o.frequency.exponentialRampToValueAtTime(720,now+.23);g.gain.setValueAtTime(.0001,now);g.gain.exponentialRampToValueAtTime(.35,now+.03);g.gain.exponentialRampToValueAtTime(.0001,now+.6);o.connect(g).connect(master);o.start();o.stop(now+.65)}

function makeWall(x,z,w,d,h=3.8){const geo=new THREE.BoxGeometry(w,h,d),mat=new THREE.MeshStandardMaterial({color:0x17191a,roughness:.9,metalness:.08});const m=new THREE.Mesh(geo,mat);m.position.set(x,h/2,z);m.castShadow=m.receiveShadow=true;scene.add(m);colliders.push({x1:x-w/2,x2:x+w/2,z1:z-d/2,z2:z+d/2});return m}
function makeFloor(){const f=new THREE.Mesh(new THREE.PlaneGeometry(44,54),new THREE.MeshStandardMaterial({color:0x0b0d0d,roughness:.92,metalness:.08}));f.rotation.x=-Math.PI/2;f.receiveShadow=true;scene.add(f);const c=new THREE.Mesh(new THREE.PlaneGeometry(44,54),new THREE.MeshStandardMaterial({color:0x080909,roughness:1,side:THREE.DoubleSide}));c.rotation.x=Math.PI/2;c.position.y=3.8;scene.add(c)}
function addBreaker(x,z,id){const group=new THREE.Group();const box=new THREE.Mesh(new THREE.BoxGeometry(.8,1.15,.22),new THREE.MeshStandardMaterial({color:0x303234,metalness:.65,roughness:.4}));const lamp=new THREE.Mesh(new THREE.SphereGeometry(.09,12,8),new THREE.MeshStandardMaterial({color:id<=save.breakers?0x37ff6b:0xa20f0f,emissive:id<=save.breakers?0x27ff5b:0x5a0000,emissiveIntensity:2.2}));lamp.position.set(.23,.26,.13);group.add(box,lamp);group.position.set(x,1.45,z);scene.add(group);const item={type:'breaker',id,group,lamp,used:id<=save.breakers};breakerObjs.push(item);interactables.push(item)}
function addExit(x,z){const g=new THREE.Group();const door=new THREE.Mesh(new THREE.BoxGeometry(2.6,3.2,.28),new THREE.MeshStandardMaterial({color:0x262a2b,metalness:.78,roughness:.35}));const bar=new THREE.Mesh(new THREE.BoxGeometry(1.5,.14,.15),new THREE.MeshStandardMaterial({color:0x7a2020,emissive:0x240000}));bar.position.set(0,.1,.2);g.add(door,bar);g.position.set(x,1.6,z);scene.add(g);const item={type:'exit',group:g,used:false};interactables.push(item);exitDoor=item}
function buildLevel(){
  makeFloor();
  makeWall(-22,0,.8,54); makeWall(22,0,.8,54); makeWall(0,-27,44,.8); makeWall(0,27,44,.8);
  // maze corridors / rooms
  makeWall(-10,18,1,18); makeWall(8,19,1,16); makeWall(0,11,12,1); makeWall(15,10,14,1);
  makeWall(-15,4,14,1); makeWall(-4,2,1,15); makeWall(9,1,1,17); makeWall(15,-7,14,1);
  makeWall(-13,-8,18,1); makeWall(-4,-15,1,13); makeWall(8,-17,1,18); makeWall(15,-20,14,1);
  // pipes / clutter visuals
  const pipeMat=new THREE.MeshStandardMaterial({color:0x282d2e,metalness:.8,roughness:.35});
  for(let i=0;i<10;i++){const p=new THREE.Mesh(new THREE.CylinderGeometry(.06,.06,5+Math.random()*5,10),pipeMat);p.rotation.z=Math.PI/2;p.position.set(-17+Math.random()*34,3.1,-23+Math.random()*46);scene.add(p)}
  addBreaker(-17,21,1); addBreaker(17,4,2); addBreaker(-15,-20,3); addExit(0,-26.6);
  monsterWaypoints.push(new THREE.Vector3(-16,0,-14),new THREE.Vector3(15,0,-14),new THREE.Vector3(15,0,15),new THREE.Vector3(-15,0,15),new THREE.Vector3(0,0,2));
}
function makeMonster(){const g=new THREE.Group();const mat=new THREE.MeshStandardMaterial({color:0x070707,roughness:.95});const body=new THREE.Mesh(new THREE.CapsuleGeometry(.42,1.55,5,10),mat);body.position.y=1.45;const head=new THREE.Mesh(new THREE.SphereGeometry(.38,16,12),mat);head.scale.set(.72,1.25,.72);head.position.y=2.62;const eyeMat=new THREE.MeshStandardMaterial({color:0xf2ece2,emissive:0xffefe2,emissiveIntensity:2});for(const x of [-.12,.12]){const e=new THREE.Mesh(new THREE.SphereGeometry(.025,8,6),eyeMat);e.position.set(x,2.68,.31);g.add(e)}g.add(body,head);g.position.set(-16,0,-15);scene.add(g);monster=g}
function init(){
  scene=new THREE.Scene();scene.background=new THREE.Color(0x030405);scene.fog=new THREE.FogExp2(0x050607,.075);
  camera=new THREE.PerspectiveCamera(72,innerWidth/innerHeight,.05,90);camera.rotation.order='YXZ';
  renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio,1.7));renderer.setSize(innerWidth,innerHeight);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;gameEl.appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0x253037,0x090909,.15));
  const red=new THREE.PointLight(0x8d1717,5,9,2);red.position.set(0,2.8,-22);scene.add(red);
  const cold=new THREE.PointLight(0x9fb7bd,1.8,15,2);cold.position.set(-16,3,18);scene.add(cold);
  flashlight=new THREE.SpotLight(0xe8efe8,10,18,Math.PI/7,.45,1.4);flashlight.castShadow=true;flashlight.shadow.mapSize.set(512,512);scene.add(flashlight);scene.add(flashlight.target);
  buildLevel();makeMonster();clock=new THREE.Clock();updateUI();animate();
}
function collides(x,z){for(const c of colliders)if(x+player.radius>c.x1&&x-player.radius<c.x2&&z+player.radius>c.z1&&z-player.radius<c.z2)return true;return false}
function tryMove(dx,dz){const nx=player.pos.x+dx,nz=player.pos.z+dz;if(!collides(nx,player.pos.z))player.pos.x=nx;if(!collides(player.pos.x,nz))player.pos.z=nz;player.pos.x=THREE.MathUtils.clamp(player.pos.x,-21,21);player.pos.z=THREE.MathUtils.clamp(player.pos.z,-26,26)}
function updatePlayer(dt){
  const f=(keys.KeyW?1:0)-(keys.KeyS?1:0)+(moveJoy.y||0), r=(keys.KeyD?1:0)-(keys.KeyA?1:0)+(moveJoy.x||0);
  sprinting=(keys.ShiftLeft||keys.ShiftRight||sprintTouch)&&player.stamina>.04&&(Math.abs(f)+Math.abs(r)>.1);
  const speed=sprinting?5.1:3.05;if(sprinting)player.stamina=Math.max(0,player.stamina-dt*.22);else player.stamina=Math.min(1,player.stamina+dt*.12);
  const len=Math.hypot(f,r)||1,ff=f/len,rr=r/len;const dx=(Math.sin(yaw)*ff+Math.cos(yaw)*rr)*speed*dt;const dz=(-Math.cos(yaw)*ff+Math.sin(yaw)*rr)*speed*dt;tryMove(dx,dz);
  if(Math.hypot(dx,dz)>.001&&ac&&performance.now()-lastStep>(sprinting?300:470)){footstep();lastStep=performance.now()}
  camera.position.copy(player.pos);camera.rotation.y=yaw;camera.rotation.x=pitch;
  flashlight.position.copy(player.pos);const dir=new THREE.Vector3(0,0,-1).applyEuler(camera.rotation);flashlight.target.position.copy(player.pos).add(dir.multiplyScalar(4));flashlight.visible=flashOn;
}
function clearLine(a,b){const dir=b.clone().sub(a),dist=dir.length();const ray=new THREE.Raycaster(a,dir.normalize(),0,dist);const walls=scene.children.filter(o=>o.isMesh&&colliders.length&&o.geometry?.type==='BoxGeometry');return ray.intersectObjects(walls,false).length===0}
function updateMonster(dt){
  if(dead||won)return;const mp=monster.position,dist=mp.distanceTo(new THREE.Vector3(player.pos.x,0,player.pos.z));
  const toP=new THREE.Vector3(player.pos.x,0,player.pos.z).sub(mp).normalize();const mForward=new THREE.Vector3(0,0,1).applyQuaternion(monster.quaternion);const canSee=dist<12&&clearLine(mp.clone().setY(1.8),player.pos.clone())&&(monsterState==='chase'||mForward.dot(toP)>.05||dist<4.5);
  if(canSee){monsterSeenTimer+=dt;if(monsterSeenTimer>.3)monsterState='chase'}else monsterSeenTimer=Math.max(0,monsterSeenTimer-dt*.7);
  let target,speed;if(monsterState==='chase'){target=new THREE.Vector3(player.pos.x,0,player.pos.z);speed=2.25+(save.breakers*.18);if(dist>18&&!canSee){monsterState='patrol';monsterTarget=(monsterTarget+1)%monsterWaypoints.length}}else{target=monsterWaypoints[monsterTarget];speed=1.3+.15*save.breakers;if(mp.distanceTo(target)<1)monsterTarget=(monsterTarget+1)%monsterWaypoints.length}
  const d=target.clone().sub(mp).setY(0);if(d.length()>.1){d.normalize();const old=mp.clone();mp.addScaledVector(d,speed*dt);if(collides(mp.x,mp.z)){mp.copy(old);monsterTarget=(monsterTarget+1)%monsterWaypoints.length}monster.rotation.y=Math.atan2(d.x,d.z)}
  danger.style.opacity=String(THREE.MathUtils.clamp((8-dist)/6,0,.8));if(ac){const urgency=THREE.MathUtils.clamp((11-dist)/10,0,1);droneGain.gain.setTargetAtTime(.12+.12*urgency,ac.currentTime,.2);if(urgency>.22){heartbeatTimer-=dt;if(heartbeatTimer<=0){thump(.35+.8*urgency);heartbeatTimer=.9-.48*urgency}}}
  if(dist<1.0){dead=true;save.deaths++;saveNow();scareSound();setTimeout(()=>{$('#death').style.display='flex'},300)}
}
function nearestInteract(){let best=null,bd=2.15;for(const it of interactables){if(it.used)continue;const d=it.group.position.distanceTo(player.pos);if(d<bd){best=it;bd=d}}return best}
function doInteract(){const it=nearestInteract();if(!it)return;if(it.type==='breaker'){if(it.id!==save.breakers+1){showMsg('NO POWER. FIND THE PREVIOUS BREAKER FIRST.');return}it.used=true;save.breakers++;it.lamp.material.color.set(0x37ff6b);it.lamp.material.emissive.set(0x27ff5b);saveNow();metalHit();showMsg(`BREAKER ${save.breakers}/3 RESTORED`);monsterState='chase';setTimeout(()=>{if(!dead)monsterState='patrol'},6000);updateUI()}else if(it.type==='exit'){if(save.breakers<3){showMsg(`EXIT LOCKED — ${3-save.breakers} BREAKER${3-save.breakers===1?'':'S'} OFFLINE`);return}won=true;elapsed=(performance.now()-startTime)/1000;save.escaped=true;if(save.best==null||elapsed<save.best)save.best=elapsed;saveNow();$('#winText').textContent=`Escape time: ${formatTime(elapsed)}${save.best===elapsed?' — NEW BEST':''}`;$('#win').style.display='flex'}}
function showMsg(t){msg.textContent=t;msg.style.opacity=1;clearTimeout(showMsg.t);showMsg.t=setTimeout(()=>msg.style.opacity=0,2200)}
function updateUI(){objective.innerHTML=`<b>OBJECTIVE</b><br>${save.breakers<3?`Restore breakers: <span class="red">${save.breakers}/3</span>`:'Get to the EXIT'}`;status.innerHTML=`🔦 ${flashOn?'ON':'OFF'}<br>STAMINA ${Math.round(player.stamina*100)}%`;const it=nearestInteract();prompt.style.opacity=it?1:0;prompt.textContent=it?(it.type==='exit'?'USE EXIT':'RESTORE BREAKER'):'';$('#interact').style.display=it?'block':'none'}
function formatTime(s){const m=Math.floor(s/60),ss=Math.floor(s%60);return `${m}:${String(ss).padStart(2,'0')}`}
function animate(){requestAnimationFrame(animate);const dt=Math.min(clock?.getDelta()||.016,.05);if(started&&!dead&&!won&&!paused){updatePlayer(dt);updateMonster(dt);updateUI()}renderer.render(scene,camera)}

addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
addEventListener('keydown',e=>{keys[e.code]=true;if(e.code==='KeyE')doInteract();if(e.code==='KeyF'){flashOn=!flashOn;updateUI()}});addEventListener('keyup',e=>keys[e.code]=false);
renderer?.domElement?.addEventListener?.('click',()=>{});
let mouseLocked=false;document.addEventListener('pointerlockchange',()=>mouseLocked=document.pointerLockElement===renderer?.domElement);document.addEventListener('mousemove',e=>{if(mouseLocked&&started&&!dead){yaw-=e.movementX*.0024;pitch=THREE.MathUtils.clamp(pitch-e.movementY*.0021,-1.22,1.22)}});

const moveJoy={x:0,y:0}, lookJoy={x:0,y:0};let sprintTouch=false;
function stick(el,state,isLook=false){const nub=el.querySelector('.nub');let id=null,lastX=0,lastY=0;el.addEventListener('pointerdown',e=>{id=e.pointerId;el.setPointerCapture(id);lastX=e.clientX;lastY=e.clientY});el.addEventListener('pointermove',e=>{if(e.pointerId!==id)return;if(isLook){const dx=e.clientX-lastX,dy=e.clientY-lastY;yaw-=dx*.008;pitch=THREE.MathUtils.clamp(pitch-dy*.007,-1.22,1.22);lastX=e.clientX;lastY=e.clientY;nub.style.transform=`translate(calc(-50% + ${THREE.MathUtils.clamp(dx*1.4,-28,28)}px),calc(-50% + ${THREE.MathUtils.clamp(dy*1.4,-28,28)}px))`}else{const r=el.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,dx=e.clientX-cx,dy=e.clientY-cy,l=Math.hypot(dx,dy),max=48,k=l>max?max/l:1;state.x=dx*k/max;state.y=-dy*k/max;nub.style.transform=`translate(calc(-50% + ${dx*k}px),calc(-50% + ${dy*k}px))`;sprintTouch=l>43}});const end=e=>{if(e.pointerId!==id)return;id=null;state.x=state.y=0;sprintTouch=false;nub.style.transform='translate(-50%,-50%)'};el.addEventListener('pointerup',end);el.addEventListener('pointercancel',end)}
stick($('#move'),moveJoy,false);stick($('#look'),lookJoy,true);
$('#flash').onclick=()=>{flashOn=!flashOn;updateUI()};$('#interact').onclick=doInteract;

function begin(){initAudio();ac?.resume();$('#start').style.display='none';$('#death').style.display='none';$('#win').style.display='none';started=true;dead=false;won=false;player.pos.set(0,1.65,15);yaw=Math.PI;pitch=0;monster.position.set(-16,0,-15);monsterState='patrol';monsterTarget=0;startTime=performance.now();if(!mobile)renderer.domElement.requestPointerLock?.()}
$('#play').onclick=begin;$('#retry').onclick=begin;$('#again').onclick=()=>{save.breakers=0;saveNow();breakerObjs.forEach((b,i)=>{b.used=false;b.lamp.material.color.set(0xa20f0f);b.lamp.material.emissive.set(0x5a0000)});begin()};
$('#reset').onclick=()=>{localStorage.removeItem(SAVE_KEY);save={breakers:0,deaths:0,best:null,escaped:false,volume:.72};saveNow();location.reload()};
$('#saveSummary').textContent=`Saved: ${save.breakers}/3 breakers · ${save.deaths} deaths${save.best?` · Best ${formatTime(save.best)}`:''}`;
init();
renderer.domElement.addEventListener('click',()=>{if(started&&!dead&&!won&&!mobile)renderer.domElement.requestPointerLock?.()});
