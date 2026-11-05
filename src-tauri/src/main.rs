// Hide the console window that Windows would otherwise open for a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    photocull_lib::run()
}
