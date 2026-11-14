// A procedural satellite view of one tropical cyclone, drawn per pixel in a WebGL fragment shader.
//
// The picture is built the way the real thing is organised: a central dense overcast, spiral
// rainbands laid out along logarithmic spirals, an eye that opens as the storm matures, thin
// cirrus outflow turning the opposite way aloft, and the damage shear, land and cold water do
// to that symmetry. Every one of those is a uniform, so the storm changes as it travels.
//
// The canvas covers a square VIEW_R34 gale-radii from the centre to each edge, north up.

export const VIEW_R34 = 3.0;

const VERT = "attribute vec2 p;varying vec2 vUv;void main(){vUv=p;gl_Position=vec4(p,0.,1.);}";

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uTime, uOrg, uInt, uEye, uEyeR, uHemi, uShear, uLand, uET, uRing, uSeed, uMode;
uniform vec2 uShearDir;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = .5, s = 0.;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + vec2(17., 9.); a *= .5; }
  return s;
}

vec2 turn(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

// Cloud texture carried round by the wind: fast near the centre, slow outside. Left alone that
// would wind the pattern ever tighter, so two copies restart out of step and cross-fade.
float flow(vec2 p, float freq, float r) {
  float w = (.45 + .9 * uInt) / (.7 + 1.4 * r);
  float ta = fract(uTime * .11), tb = fract(uTime * .11 + .5);
  float na = fbm(turn(p, w * ta * 5.) * freq + uSeed);
  float nb = fbm(turn(p, w * tb * 5.) * freq + uSeed + 31.7);
  return mix(na, nb, abs(2. * ta - 1.));
}

// x: deep convective cloud, y: thin cirrus aloft, z: exposed low-level swirl.
// q is in gale radii, already mirrored so the code below is written for the northern hemisphere
// with +y poleward.
vec3 clouds(vec2 q) {
  // Shear pushes the convection downshear of the surface centre.
  vec2 off = uShearDir * uShear * .5 * (1. - .55 * uOrg);
  vec2 p = q - off;
  float r = length(p);
  float a = atan(p.y, p.x);
  // The band pattern turns as a whole; a mature storm winds its bands tighter.
  float spin = uTime * (.1 + .12 * uInt);
  float k = mix(.8, 1.75, uOrg);
  float s = a - spin + k * log(r + .28);
  float lumps = flow(p, 1.5, r);
  float cells = flow(p, 4.6, r);
  float arms = .5 + .5 * cos(2. * s + 3.0 * (lumps - .5));
  // A third, weaker band fills in on big, mature storms.
  float arms3 = .5 + .5 * cos(3. * s + 2.1 + 3.4 * (lumps - .5) + uSeed);
  // One side always carries the principal band.
  float lead = .84 + .16 * cos(a - spin - 1.1 + uSeed);

  // Central dense overcast with a ragged, lobed edge.
  float rc = mix(.36, .86, uInt) * (.72 + .36 * uOrg);
  float edge = (lumps - .5) * .55 + (cells - .5) * .18;
  float cdo = smoothstep(rc + edge + .1, rc + edge - .14, r) * smoothstep(.1, .55, uOrg + .4 * uInt);

  // Broad rainbands, fattest where they feed into the overcast, broken into cells.
  float reach = mix(1.45, 2.4, uOrg);
  float mask = smoothstep(rc * .55, rc * 1.05, r) * smoothstep(reach, reach * .6, r);
  float near = 1. - smoothstep(rc, rc * 2.2, r);
  float band = smoothstep(.4, .7, max(arms, arms3 * .78 * uOrg) * lead + .26 * near) * mask;
  band *= smoothstep(.26, .48, cells + .24 * uOrg);

  // A young or wrecked storm is just clumps of thunderstorms near the centre.
  float clumps = smoothstep(.5, .72, flow(p + 3., 1.9, r)) * smoothstep(1.5, .15, r) * (1. - uOrg);

  float d = max(max(cdo, band * .92), clumps * .95);

  // The upshear half is scoured clear.
  float side = dot(normalize(q + 1e-4), uShearDir);
  d *= mix(1., smoothstep(-.95, .45, side), uShear * smoothstep(.12, .8, length(q)));
  // Over land the cloud shield breaks up.
  d *= 1. - uLand * .65 * smoothstep(.34, .62, fbm(q * 3.4 + uSeed + 5.));

  // Extratropical transition: a comma. Cloud piles up poleward and a cold-front tail trails away.
  float head = smoothstep(1.35, .25, length(q - vec2(-.2, .7)) + (lumps - .5) * .7);
  float tailLine = abs(q.x - (.45 + .2 * q.y * q.y) + (lumps - .5) * .3);
  float tail = smoothstep(.36, .05, tailLine) * smoothstep(.3, -.4, q.y) * smoothstep(-2.5, -1., q.y);
  float dry = smoothstep(.1, .65, length(q - vec2(.2, -.3)));
  d = mix(d, max(head, tail) * dry * smoothstep(.25, .5, cells + .15), uET);

  // A moat between the old eyewall and the new one during an eyewall replacement.
  d *= 1. - .7 * uRing * smoothstep(.07, 0., abs(r - uEyeR * 2.6));
  // The eye.
  d *= mix(1., smoothstep(uEyeR * .75, uEyeR * 1.25, r), uEye);

  // Cirrus outflow: thin, wide, and fanning out the other way.
  float s2 = a + spin * .3 - .7 * log(r + .3);
  float cir = fbm(vec2(cos(s2), sin(s2)) * 1.6 + r * 1.3 + uSeed * 2.) * (.6 + .8 * lumps);
  float cirrus = smoothstep(.4, .7, cir) * smoothstep(2.7, 1.3, r) * smoothstep(rc * .9, rc * 2.8, r) * uOrg * (.15 + .85 * uInt) * (1. - .6 * uET);
  cirrus *= mix(1., smoothstep(-.6, .7, side), .7 * uShear);

  // What shear leaves behind: a naked low-cloud swirl at the true centre.
  float rq = length(q);
  float sw = .5 + .5 * cos(atan(q.y, q.x) - uTime * .25 + 1.3 * log(rq + .3) + 2.5 * (lumps - .5));
  float low = smoothstep(.35, .85, sw) * smoothstep(.85, .2, rq) * smoothstep(.04, .2, rq) * smoothstep(.3, .8, uShear) * (1. - uLand) * smoothstep(.38, .55, cells);

  return vec3(clamp(d, 0., 1.), cirrus, low);
}

// Cloud-top height: the convective towers that give a real storm its cauliflower look.
float relief(vec2 q, float d) {
  float n = flow(q, 8.5, length(q));
  float towers = 1. - abs(2. * n - 1.);
  return d * (.62 + .5 * towers);
}

// Enhanced-infrared palette: the colder (higher) the cloud top, the further along the scale.
vec3 infrared(float t) {
  vec3 c = mix(vec3(.25, .27, .3), vec3(.7, .72, .75), smoothstep(0., .3, t));
  c = mix(c, vec3(.1, .55, .85), smoothstep(.3, .42, t));
  c = mix(c, vec3(.1, .75, .35), smoothstep(.45, .55, t));
  c = mix(c, vec3(.98, .9, .2), smoothstep(.58, .68, t));
  c = mix(c, vec3(.93, .2, .15), smoothstep(.7, .8, t));
  c = mix(c, vec3(.25, .05, .1), smoothstep(.84, .9, t));
  c = mix(c, vec3(.95, .95, .98), smoothstep(.93, .99, t));
  return c;
}

void main() {
  vec2 q = vUv * ${VIEW_R34.toFixed(1)};
  // Mirroring north-south flips the rotation and keeps +y pointing poleward in both hemispheres.
  q.y *= uHemi;
  vec3 c = clouds(q);
  float h = relief(q, c.x);
  // Sunlight from the upper left: slopes facing it are bright, the far sides fall into shadow.
  vec2 sun = vec2(-.7, .7 * uHemi) * .05;
  float h2 = relief(q + sun, clouds(q + sun).x);
  float lit = clamp(.62 + (h - h2) * 3.2, 0., 1.);
  // Ragged edges: the cloud ends where its own texture runs out, not on a smooth contour.
  float deep = smoothstep(.13, .4, h);
  // A thin anvil veil spreads a little beyond the thick cloud.
  float veil = smoothstep(.02, .3, c.x) * .38;
  float alpha = max(max(deep, veil), max(c.y * .3, c.z * .36));
  vec3 col;
  if (uMode > .5) {
    float top = h * (.62 + .5 * uInt) + c.y * .2;
    col = infrared(clamp(top, 0., 1.));
    alpha = max(alpha, smoothstep(.04, .16, top));
  } else {
    vec3 thick = mix(vec3(.44, .5, .62), vec3(1.), lit) * (.84 + .16 * smoothstep(.25, .85, h));
    vec3 thin = vec3(.94, .96, .99);
    vec3 lowc = vec3(.82, .84, .88);
    col = mix(mix(lowc, thin, step(c.z * .36, max(c.y * .3, veil))), thick, deep);
  }
  alpha *= smoothstep(1., .8, length(vUv));
  gl_FragColor = vec4(col * alpha, alpha);
}`;

const UNIFORMS = ["uTime", "uOrg", "uInt", "uEye", "uEyeR", "uHemi", "uShear", "uLand", "uET", "uRing", "uSeed", "uMode", "uShearDir"];

export function createCloudRenderer(size = 512) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
  if (!gl) {
    return { ok: false, canvas };
  }
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
  };
  let loc;
  try {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const attr = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(attr);
    gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);
    loc = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]));
  } catch (error) {
    console.warn("Cloud shader unavailable:", error.message);
    return { ok: false, canvas };
  }

  // point: one hour of a simulated storm. seed keeps a storm's look its own.
  const render = (point, time, { infrared = false, seed = 1 } = {}) => {
    const h = point.lat >= 0 ? 1 : -1;
    gl.viewport(0, 0, size, size);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(loc.uTime, time);
    gl.uniform1f(loc.uOrg, point.org);
    gl.uniform1f(loc.uInt, Math.min(1, Math.max(0, (point.v - 10) / 55)));
    gl.uniform1f(loc.uEye, point.eye);
    gl.uniform1f(loc.uEyeR, point.eyeR);
    gl.uniform1f(loc.uHemi, h);
    gl.uniform1f(loc.uShear, point.shearMag);
    gl.uniform1f(loc.uLand, point.landf);
    gl.uniform1f(loc.uET, point.et);
    gl.uniform1f(loc.uRing, point.ring);
    gl.uniform1f(loc.uSeed, (seed % 97) * 0.37 + 1.3);
    gl.uniform1f(loc.uMode, infrared ? 1 : 0);
    // The shader works in a north-south mirrored frame for the southern hemisphere.
    gl.uniform2f(loc.uShearDir, point.sx, point.sy * h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  return { ok: true, canvas, render };
}
