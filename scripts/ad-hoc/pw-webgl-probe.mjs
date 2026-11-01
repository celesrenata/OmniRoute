import { chromium } from "@playwright/test";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    errors.push("console:" + m.type() + ": " + m.text());
});

await page.setContent(
  `<canvas id="c" width="640" height="360" style="width:640px;height:360px"></canvas>
   <script>
   (function () {
     try {
       var c = document.getElementById('c');
       var gl = c.getContext('webgl2');
       document.title = 'gl=' + (gl ? 'OK' : 'FAIL');
       if (!gl) return;
       document.title += ' ' + gl.getParameter(gl.RENDERER) + ' | ' + gl.getParameter(gl.VERSION);
       var vs = 'attribute vec2 a; void main(){ gl_Position = vec4(a,0.,1.); }';
       var fs = 'precision mediump float; void main(){ gl_FragColor = vec4(0.2,0.5,0.9,1.0); }';
       var sh = function(t,s){var h=gl.createShader(t);gl.shaderSource(h,s);gl.compileShader(h);return h;};
       var p = gl.createProgram();
       gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
       gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
       gl.linkProgram(p);
       var ok = gl.getProgramParameter(p, gl.LINK_STATUS);
       document.title += ' link=' + ok;
       gl.useProgram(p);
       var b = gl.createBuffer();
       gl.bindBuffer(gl.ARRAY_BUFFER, b);
       gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
       var loc = gl.getAttribLocation(p, 'a');
       gl.enableVertexAttribArray(loc);
       gl.vertexAttribPointer(loc, 2, false, 0, 0, 0);
       gl.clearColor(0,0,0,1);
       gl.clear(gl.COLOR_BUFFER_BIT);
       gl.drawArrays(gl.TRIANGLES, 0, 3);
       var px = new Uint8Array(4);
       gl.readPixels(320, 180, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
       document.title += ' px=' + Array.from(px);
     } catch (e) {
       document.title = 'EXC ' + e.message;
     }
   })();
   </script>`
);
await page.waitForTimeout(2000);
console.log("title =", await page.title());
console.log("errors =", JSON.stringify(errors, null, 2));
await page.screenshot({ path: "/tmp/pw-webgl-shot.png" });
await browser.close();
