const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{execFile}=require('node:child_process'),{promisify}=require('node:util');const execute=promisify(execFile);
async function inspect(arch){const bundle=path.resolve('release',`PhotoCull-darwin-${arch}`,'PhotoCull.app'),app=path.join(bundle,'Contents','Resources','app');const executable=path.join(bundle,'Contents','MacOS','PhotoCull');
 const header=await fs.readFile(executable);assert.equal(header.readUInt32LE(0),0xfeedfacf);assert.equal(header.readUInt32LE(4),arch==='arm64'?0x100000c:0x1000007);
 const plist=await fs.readFile(path.join(bundle,'Contents','Info.plist'),'utf8');assert.match(plist,/app.photocull.desktop/);assert.match(plist,/NSRemovableVolumesUsageDescription/);
 for(const file of ['src/main.cjs','src/raw-worker.cjs','src/devices.cjs','node_modules/libraw-wasm-nothread/dist/libraw.wasm','node_modules/exiftool-vendored.pl/bin/exiftool'])await fs.access(path.join(app,file));
 const nativeFolder=path.join(app,'node_modules',`@img/sharp-darwin-${arch}/lib`);
 const nativeName=(await fs.readdir(nativeFolder)).find(name=>name.endsWith('.node'));assert.ok(nativeName);
 const nativeHeader=await fs.readFile(path.join(nativeFolder,nativeName));assert.equal(nativeHeader.readUInt32LE(4),arch==='arm64'?0x100000c:0x1000007);
 const exif=await execute('perl',[path.join(app,'node_modules/exiftool-vendored.pl/bin/exiftool'),'-ver'],{timeout:10000});assert.match(exif.stdout,/\d+\.\d+/);
 const report={arch,bundle,version:JSON.parse(await fs.readFile(path.join(app,'package.json'),'utf8')).version,checks:['Mach-O executable matches requested CPU','bundle identifier and removable-volume permission text','native sharp module for macOS architecture','portable LibRaw WASM present','vendored Perl ExifTool executes under Linux Perl'],runtimeTested:false,limitations:['Cross-built on Linux; macOS UI, permissions, card discovery and actual native modules require testing on Mac hardware.','Development builds are not Developer ID signed or notarized.']};
 await fs.mkdir('artifacts/macos-validation',{recursive:true});await fs.writeFile(path.join('artifacts/macos-validation',arch+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
async function main(){for(const arch of process.argv[2]?[process.argv[2]]:['arm64','x64'])await inspect(arch);}
main().catch(e=>{console.error(e);process.exitCode=1;});
