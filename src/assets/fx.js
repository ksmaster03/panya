// ฉากหลัง shader แบบผ้าไหมที่ไหลช้า ๆ: ใส่ <canvas class="fx" data-fx="silk"> ไว้ในกล่องที่ position: relative
// สีอ่านจากตัวแปร CSS --fx-bg / --fx-a / --fx-b (ui.css) จึงเปลี่ยนตามธีม
// ประหยัดเครื่อง: วาดที่ความละเอียดครึ่งหนึ่ง หยุดเมื่อเลื่อนพ้นจอหรือสลับแท็บ และวาดภาพนิ่งภาพเดียวเมื่อผู้ใช้ตั้งลดการเคลื่อนไหว
(() => {
  const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'
  // บิดพิกัดด้วยคลื่น sine ซ้อนกันหลายชั้น ได้รอยพับคล้ายผ้า แล้วเน้นสันคลื่นเป็นแสงเงา
  const FRAG = `precision mediump float;
uniform vec2 r;uniform float t;uniform vec3 bg,ca,cb;
void main(){
  vec2 p=(gl_FragCoord.xy-.5*r)/r.y;
  vec2 q=p*1.25+vec2(.35,.1);
  float tt=t*.08;
  for(int i=1;i<6;i++){float f=float(i);q+=vec2(.55/f*sin(f*q.y+tt+.3*f),.42/f*cos(f*q.x+tt*.85+.5*f));}
  float s=.5+.5*sin(q.x*1.35+q.y*.75);
  float body=pow(s,2.6),rim=pow(s,16.);
  vec3 col=mix(bg,ca,body*.85);
  col=mix(col,cb,rim*.6);
  // แสงหนาที่มุมขวาบน จางลงไปทางกลางและล่างที่มีตัวหนังสือ
  float fade=smoothstep(1.15,.05,length(p*vec2(.7,1.)-vec2(.42,.32)));
  col=mix(bg,col,fade);
  gl_FragColor=vec4(col,1.);
}`
  const hex = (v) => { const m = /#?([0-9a-f]{6})/i.exec(v || ''); const n = m ? parseInt(m[1], 16) : 0; return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255] }
  const still = matchMedia('(prefers-reduced-motion: reduce)')

  function silk(cv) {
    const gl = cv.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' })
    if (!gl) { cv.remove(); return }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s }
    const prog = gl.createProgram()
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { cv.remove(); return }
    gl.useProgram(prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const u = Object.fromEntries(['r', 't', 'bg', 'ca', 'cb'].map((k) => [k, gl.getUniformLocation(prog, k)]))
    const colors = () => { const cs = getComputedStyle(cv); gl.uniform3fv(u.bg, hex(cs.getPropertyValue('--fx-bg'))); gl.uniform3fv(u.ca, hex(cs.getPropertyValue('--fx-a'))); gl.uniform3fv(u.cb, hex(cs.getPropertyValue('--fx-b'))) }
    const size = () => {
      const scale = Math.min(devicePixelRatio || 1, 2) * 0.5
      const w = Math.max(1, Math.round(cv.clientWidth * scale)), h = Math.max(1, Math.round(cv.clientHeight * scale))
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); gl.uniform2f(u.r, w, h) }
    }
    let visible = true, raf = 0, t0 = performance.now() - 14000
    const draw = (now) => { size(); gl.uniform1f(u.t, (now - t0) / 1000); gl.drawArrays(gl.TRIANGLES, 0, 3) }
    const loop = (now) => { draw(now); raf = visible && !document.hidden && !still.matches ? requestAnimationFrame(loop) : 0 }
    const kick = () => { if (!raf) raf = requestAnimationFrame(loop) }
    colors(); kick()
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick() }).observe(cv)
    document.addEventListener('visibilitychange', kick)
    document.addEventListener('panya:theme', () => { colors(); kick() })
    addEventListener('resize', kick, { passive: true })
    still.addEventListener('change', kick)
  }

  const init = () => { for (const cv of document.querySelectorAll('canvas[data-fx="silk"]')) silk(cv) }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init()
})()
