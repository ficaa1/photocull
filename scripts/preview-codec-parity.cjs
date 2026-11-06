// node scripts/preview-codec-parity.cjs RUST_PROBE_EXE COPIED_TIFF COPIED_JPEG REPORT_FOLDER
// No source writes. Synthetic fixtures and probe output live in a temporary directory.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const sharp = require('sharp'), { createHash } = require('node:crypto');
const { Probe } = require('./preview-codec-bench.cjs');
const { encodeDisplayPreview } = require('../src/display-preview.cjs');
async function main() {
  const [exe, tiff, jpeg, reports] = process.argv.slice(2); assert.ok(reports);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-codec-colour-')); await fs.mkdir(reports, { recursive: true });
  const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const before = await Promise.all([tiff, jpeg].map(digest));
  const probe = new Probe(exe, root, 0), rows = [];
  try {
    const colors = [[114,175,203], [17,50,72], [147,185,199]], pixels = Buffer.alloc(900 * 600 * 3);
    for (let y=0;y<600;y++) for(let x=0;x<900;x++) pixels.set(colors[Math.floor(x/300)],(y*900+x)*3);
    const base = sharp(pixels,{raw:{width:900,height:600,channels:3}});
    const cases = [{name:'copied-tiff',file:tiff},{name:'copied-jpeg',file:jpeg}];
    for (const [name, make] of [
      ['srgb-tiff', () => base.clone().withIccProfile('srgb').toColourspace('rgb16').tiff({compression:'none'})],
      ['p3-tiff', () => base.clone().withIccProfile('p3').toColourspace('rgb16').tiff({compression:'none'})],
      ['png', () => base.clone().png()], ['webp', () => base.clone().webp({lossless:true})]
    ]) { const file=path.join(root,name);await make().toFile(file);cases.push({name,file}); }
    const untagged=Buffer.from(await fs.readFile(path.join(root,'srgb-tiff'))), ifd=untagged.readUInt32LE(4);
    for(let i=0;i<untagged.readUInt16LE(ifd);i++) {const offset=ifd+2+i*12;if(untagged.readUInt16LE(offset)===34675) untagged.writeUInt16LE(65000,offset);}
    const plain=path.join(root,'untagged-tiff');await fs.writeFile(plain,untagged);cases.push({name:'untagged-tiff',file:plain});
    // Asymmetric four-quadrant image verifies all mirror/rotation combinations.
    const quadrants=Buffer.alloc(180*120*3);
    for(let y=0;y<120;y++)for(let x=0;x<180;x++)quadrants.set([x<90?210:30,y<60?210:30,x<90?25:140],(y*180+x)*3);
    for(let orientation=1;orientation<=8;orientation++) {
      const file=path.join(root,'orientation-'+orientation+'.png');
      await sharp(quadrants,{raw:{width:180,height:120,channels:3}}).withMetadata({orientation}).png().toFile(file);
      cases.push({name:'orientation-'+orientation,file});
    }
    for(const {name,file} of cases)for(const edge of name.startsWith('copied')?[400,2560]:[400,2560,100000]) {
      const options={edge,quality:edge===400?76:91};
      const reference=await encodeDisplayPreview(file,options), actual=await probe.encode(file,options);
      const a=await sharp(reference).raw().toBuffer({resolveWithObject:true}), b=await sharp(actual).raw().toBuffer({resolveWithObject:true});
      assert.equal(b.info.width,a.info.width,name);assert.equal(b.info.height,a.info.height,name);
      assert.ok((await sharp(actual).metadata()).hasProfile,name);
      const samples=[];
      for(const [u,v]of [[.5,.2],[.75,.45],[.75,.85],[.18,.60],[.12,.48]]) {
        const x=Math.round(a.info.width*u),y=Math.round(a.info.height*v),values=[[],[]];
        for(const [index,image]of [a,b].entries())for(let c=0;c<3;c++) {
          let sum=0;for(let dy=-5;dy<5;dy++)for(let dx=-5;dx<5;dx++)sum+=image.data[((y+dy)*image.info.width+x+dx)*image.info.channels+c];values[index].push(sum/100);
        }
        samples.push({reference:values[0],rust:values[1],maxError:Math.max(...values[0].map((v,i)=>Math.abs(v-values[1][i])))});
      }
      const row={name,edge,width:b.info.width,height:b.info.height,icc:true,maxPatchError:Math.max(...samples.map(s=>s.maxError)),samples};
      rows.push(row);console.log(JSON.stringify(row));
      await fs.writeFile(path.join(reports,'preview-parity.json'),JSON.stringify({rows},null,2));
      row.withinThree = row.maxPatchError <= 3;
    }
    assert.deepEqual(await Promise.all([tiff,jpeg].map(digest)),before);
    await fs.writeFile(path.join(reports,'preview-parity.json'),JSON.stringify({sourceHashesUnchanged:true,withinThree:rows.every(r=>r.withinThree),rows},null,2));
    assert.ok(rows.every(r=>r.withinThree), 'Rust probe exceeds the three-level patch tolerance; see preview-parity.json');
  }finally{await probe.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
