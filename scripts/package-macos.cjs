const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
async function run(command,args,options={}){await new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'inherit',shell:false,...options});child.on('error',reject);child.on('close',code=>code?reject(new Error(`${command} exited with ${code}`)):resolve());});}
async function build(arch){
 if(!['arm64','x64'].includes(arch))throw new Error('Mac architecture must be arm64 or x64.');
 const icon=await require('./make-macos-icon.cjs').make();
 const root=path.resolve(__dirname,'..'),stage=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-mac-'));
 try{const{devDependencies,scripts,...pkg}=require('../package.json');await fs.writeFile(path.join(stage,'package.json'),JSON.stringify(pkg,null,2));for(const folder of ['src','assets','docs','third-party'])await fs.cp(path.join(root,folder),path.join(stage,folder),{recursive:true});await fs.copyFile(path.join(root,'README.md'),path.join(stage,'README.md'));
 const npmCandidates=[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')];let cli;for(const candidate of npmCandidates)try{await fs.access(candidate);cli=candidate;break;}catch{}
 if(!cli)throw new Error('npm CLI could not be located.');
 await run(process.execPath,[cli,'install','--prefix',stage,'--omit=dev','--ignore-scripts','--os=darwin','--cpu='+arch,'--package-lock=false']);
 const{packager}=await import('@electron/packager');
 const output=await packager({dir:stage,name:'PhotoCull',executableName:'PhotoCull',platform:'darwin',arch,icon,electronVersion:require('electron/package.json').version,out:path.join(root,'release'),overwrite:true,asar:false,prune:false,appBundleId:'app.photocull.desktop',darwinDarkModeSupport:true,extendInfo:{NSRemovableVolumesUsageDescription:'PhotoCull reads camera cards to review photos and copy your picks.',NSDocumentsFolderUsageDescription:'PhotoCull opens photo folders and copies selected originals.',NSDownloadsFolderUsageDescription:'PhotoCull opens photo folders and saves selected originals.'}});
 for(const folder of output){const bundle=path.join(folder,'PhotoCull.app');if(process.platform==='darwin')await run('codesign',['--force','--deep','--sign','-','--entitlements',path.join(bundle,'Contents/Resources/app/assets/entitlements.mac.plist'),bundle]);await fs.copyFile(path.join(root,'scripts','prepare-macos.command'),path.join(folder,'Prepare PhotoCull.command'));await fs.chmod(path.join(folder,'Prepare PhotoCull.command'),0o755);const archive=path.join(root,'release',`PhotoCull-macOS-${arch}.zip`);await fs.rm(archive,{force:true});if(process.platform==='darwin')await run('ditto',['-c','-k','--sequesterRsrc','--keepParent',path.basename(folder),archive],{cwd:path.dirname(folder)});else await run('python3',[path.join(root,'scripts/archive-macos.py'),folder,archive]);console.log('macOS application:',bundle,'\nArchive:',archive);}
 }finally{await fs.rm(stage,{recursive:true,force:true});}
}
async function main(){const target=process.argv[2]||'all';for(const arch of target==='all'?['arm64','x64']:[target])await build(arch);}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1});
module.exports={build};
