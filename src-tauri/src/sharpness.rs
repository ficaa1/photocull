//! Background focus ranking on cached, oriented display previews.
use std::sync::{atomic::{AtomicU64, Ordering}, OnceLock};
use serde_json::json;
use tauri::State;
use crate::backend::Backend;

static EPOCH: AtomicU64 = AtomicU64::new(0);
static WORKER: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

#[tauri::command]
pub fn sharpness_cancel() { EPOCH.fetch_add(1, Ordering::Relaxed); }

fn cancelled(epoch: u64) -> bool { EPOCH.load(Ordering::Relaxed) != epoch }

// Variance of a four-neighbour Laplacian on Rec.709 luminance. The focus region
// gets four times the weight; use at least 12% of each axis for a stable sample.
fn measure(width: usize, height: usize, pixels: &[[u8; 4]], focus: Option<(f64,f64,f64,f64)>, epoch: u64) -> Result<f64,String> {
    if width<3 || height<3 || pixels.len()!=width*height { return Err("Preview is too small for focus analysis.".into()); }
    let luma=|i:usize| { let p=pixels[i]; 0.2126*p[0] as f64+0.7152*p[1] as f64+0.0722*p[2] as f64 };
    let mut total=0.0;let mut sum=0.0;let mut squares=0.0;
    for y in 1..height-1 {
        if y%32==0 && cancelled(epoch) { return Err("Focus analysis cancelled.".into()); }
        for x in 1..width-1 {
            let i=y*width+x;
            let value=luma(i-1)+luma(i+1)+luma(i-width)+luma(i+width)-4.0*luma(i);
            let weight=if focus.is_some_and(|(fx,fy,fw,fh)| (x as f64/width as f64-fx).abs()<=fw.max(0.12)/2.0 && (y as f64/height as f64-fy).abs()<=fh.max(0.12)/2.0) {4.0} else {1.0};
            total+=weight;sum+=value*weight;squares+=value*value*weight;
        }
    }
    Ok((squares/total-(sum/total).powi(2)).max(0.0))
}

#[tauri::command]
pub async fn sharpness_score(backend: State<'_,Backend>, session: String, id: String) -> Result<f64,String> {
    let epoch=EPOCH.load(Ordering::Relaxed);
    let _permit=WORKER.get_or_init(||tokio::sync::Semaphore::new(1)).acquire().await.map_err(|e|e.to_string())?;
    if cancelled(epoch) { return Err("Focus analysis cancelled.".into()); }
    let source=backend.call("analysis-source",json!([session,id])).await?;
    if cancelled(epoch) { return Err("Focus analysis cancelled.".into()); }
    if let Some(score)=source["score"].as_f64() { return Ok(score); }
    let file=source["file"].as_str().ok_or("No cached preview available.")?.to_owned();
    let key=source["key"].as_str().ok_or("No photo identity available.")?.to_owned();
    let focus=&source["focus"];
    let point=focus["x"].as_f64().zip(focus["y"].as_f64()).map(|(x,y)|(x,y,focus["width"].as_f64().unwrap_or(0.025),focus["height"].as_f64().unwrap_or(0.025)));
    let score=tauri::async_runtime::spawn_blocking(move || {
        let _priority=BackgroundPriority::new();
        if cancelled(epoch) { return Err("Focus analysis cancelled.".to_string()); }
        let bytes=std::fs::read(file).map_err(|e|e.to_string())?;
        let decoded=lightcraft_codecs::decode(&bytes,Default::default()).map_err(|e|e.to_string())?;
        let orientation=lightcraft_geom::Orientation::from_exif(decoded.orientation);
        let image=decoded.to_srgb8().into_oriented(orientation);
        measure(image.width,image.height,&image.data,point,epoch)
    }).await.map_err(|e|e.to_string())??;
    if cancelled(epoch) { return Err("Focus analysis cancelled.".into()); }
    backend.call("analysis-store",json!([session,id,key,score])).await?;
    Ok(score)
}

struct BackgroundPriority;
impl BackgroundPriority {
    fn new() -> Self {
        #[cfg(windows)]
        unsafe { SetThreadPriority(GetCurrentThread(), -1); }
        Self
    }
}
impl Drop for BackgroundPriority {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe { SetThreadPriority(GetCurrentThread(), 0); }
    }
}
#[cfg(windows)]
#[link(name="kernel32")]
extern "system" {
    fn GetCurrentThread() -> *mut std::ffi::c_void;
    fn SetThreadPriority(thread: *mut std::ffi::c_void, priority: i32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sharp_edges_rank_above_blurred_edges() {
        let (w,h)=(96,64);
        let sharp:Vec<[u8;4]>=(0..w*h).map(|i|{let v=if ((i%w)/4+(i/w)/4)%2==0 {230} else {25};[v,v,v,255]}).collect();
        let mut blurred=sharp.clone();
        for _ in 0..6 { let old=blurred.clone();for y in 1..h-1 {for x in 1..w-1 {let i=y*w+x;let v=((old[i][0] as u16+old[i-1][0] as u16+old[i+1][0] as u16+old[i-w][0] as u16+old[i+w][0] as u16)/5) as u8;blurred[i]=[v,v,v,255];}} }
        let epoch=EPOCH.load(Ordering::Relaxed);
        assert!(measure(w,h,&sharp,None,epoch).unwrap()>measure(w,h,&blurred,None,epoch).unwrap()*4.0);
        assert_eq!(measure(w,h,&vec![[128,128,128,255];w*h],None,epoch).unwrap(),0.0);
    }
    #[test]
    fn focus_region_increases_local_detail_weight() {
        let (w,h)=(100,100);let mut pixels=vec![[128,128,128,255];w*h];
        for y in 43..57 {for x in 43..57 {let v=if(x+y)%2==0 {240} else {20};pixels[y*w+x]=[v,v,v,255];}}
        let epoch=EPOCH.load(Ordering::Relaxed);
        assert!(measure(w,h,&pixels,Some((0.5,0.5,0.2,0.2)),epoch).unwrap()>measure(w,h,&pixels,None,epoch).unwrap()*2.0);
        assert!(measure(1,1,&[],None,epoch).is_err());
    }
}
