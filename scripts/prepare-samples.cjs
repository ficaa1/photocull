// node scripts/prepare-samples.cjs SOURCE_FOLDER NEW_FIXTURE_FOLDER [COPIED_TIFF_SOURCE]
// Copies three RAW/JPEG pairs to anonymous fixture names; source files are read only.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
async function prepare(source,output,tiff){
 assert.ok(source&&output,'Pass source and new fixture folders.');source=path.resolve(source);output=path.resolve(output);
 const relative=path.relative(source,output);assert.ok(relative.startsWith('..')||path.isAbsolute(relative),'Fixture output must be outside the source folder.');
 const names=(await fs.readdir(source)).sort(),pairs=names.filter(n=>/\.arw$/i.test(n)).map(raw=>({raw,jpeg:names.find(n=>n.replace(/\.jpe?g$/i,'').toLowerCase()===raw.replace(/\.arw$/i,'').toLowerCase()&&/\.jpe?g$/i.test(n))})).filter(p=>p.jpeg).slice(0,3);
 assert.equal(pairs.length,3,'Supply at least three RAW/JPEG pairs.');
 await fs.mkdir(output,{recursive:true});assert.deepEqual(await fs.readdir(output),[],'Fixture folder must be empty.');
 for(const [i,pair]of pairs.entries())for(const [name,extension]of [[pair.raw,'ARW'],[pair.jpeg,'JPG']])await fs.copyFile(path.join(source,name),path.join(output,`sample-${String(i+1).padStart(2,'0')}.${extension}`),require('node:fs').constants.COPYFILE_EXCL);
 if(tiff)await fs.copyFile(path.resolve(tiff),path.join(output,'sample-edit.tif'),require('node:fs').constants.COPYFILE_EXCL);
 return output;
}
if(require.main===module)prepare(...process.argv.slice(2)).then(console.log).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={prepare};
