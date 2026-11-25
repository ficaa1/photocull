//! Sony PTP/SDIO protocol core. Uses only `std` so it builds and tests without the app.

#![allow(dead_code)]

pub mod card;
pub mod codec;
#[cfg(test)]
mod fixtures;
pub mod ptp;
pub mod ptpip;
pub mod session;
pub mod transport;
