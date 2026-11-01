//! Coordinate math shared by capture and input (pure, unit-tested).
//!
//! Coordinate space: every input action takes **global screen points** — the CGEvent/Quartz space,
//! origin at the top-left of the main display, y grows downward, secondary displays at their
//! arranged offsets (may be negative). A screenshot of rect R at image size W×H maps image pixel
//! (px, py) to point (R.x + px · R.w / W, R.y + py · R.h / H).

#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Serialize)]
pub struct Rect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool { x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h }
}

/// Output image size for a capture of `points` (w×h points) whose native image is `native` pixels.
/// `retina` keeps native pixels; otherwise one image pixel per point. `max_edge` caps the longest side.
pub fn output_size(points: (f64, f64), native: (usize, usize), retina: bool, max_edge: Option<u32>) -> (usize, usize) {
    let (mut w, mut h) = if retina { (native.0 as f64, native.1 as f64) } else { (points.0.round(), points.1.round()) };
    if let Some(max) = max_edge.filter(|m| *m >= 64) {
        let longest = w.max(h);
        if longest > max as f64 { let k = max as f64 / longest; w = (w * k).round(); h = (h * k).round(); }
    }
    ((w.max(1.0)) as usize, (h.max(1.0)) as usize)
}

/// Index of the display that contains the point, if any.
pub fn display_at(displays: &[Rect], x: f64, y: f64) -> Option<usize> { displays.iter().position(|d| d.contains(x, y)) }

/// Overlap of two rects, if they share any area.
pub fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let (x0, y0) = (a.x.max(b.x), a.y.max(b.y));
    let (x1, y1) = ((a.x + a.w).min(b.x + b.w), (a.y + a.h).min(b.y + b.h));
    (x1 > x0 && y1 > y0).then(|| Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
}

/// ScreenCaptureKit captures one display per call: picks the display a region overlaps most and
/// returns (display index, the region clipped to it in global points, the same rect relative to
/// that display's origin — SCStreamConfiguration.sourceRect).
pub fn region_on_display(displays: &[Rect], region: Rect) -> Option<(usize, Rect, Rect)> {
    let (index, clipped) = displays.iter().enumerate()
        .filter_map(|(i, d)| intersect(*d, region).map(|r| (i, r)))
        .max_by(|a, b| (a.1.w * a.1.h).total_cmp(&(b.1.w * b.1.h)))?;
    let d = displays[index];
    Some((index, clipped, Rect { x: clipped.x - d.x, y: clipped.y - d.y, w: clipped.w, h: clipped.h }))
}

/// Native pixel size of `points` at a backing `scale`.
pub fn native_size(points: (f64, f64), scale: f64) -> (usize, usize) {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    ((points.0 * s).round().max(1.0) as usize, (points.1 * s).round().max(1.0) as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_size_defaults_to_points() {
        assert_eq!(output_size((1728.0, 1117.0), (3456, 2234), false, None), (1728, 1117));
        assert_eq!(output_size((1728.0, 1117.0), (3456, 2234), true, None), (3456, 2234));
        assert_eq!(output_size((1728.0, 1117.0), (3456, 2234), false, Some(1280)), (1280, 827));
        assert_eq!(output_size((100.0, 50.0), (200, 100), false, Some(10)), (100, 50), "tiny caps are ignored");
    }

    #[test]
    fn display_lookup_handles_negative_offsets() {
        let displays = [Rect { x: 0.0, y: 0.0, w: 1728.0, h: 1117.0 }, Rect { x: -1920.0, y: -200.0, w: 1920.0, h: 1080.0 }];
        assert_eq!(display_at(&displays, 10.0, 10.0), Some(0));
        assert_eq!(display_at(&displays, -5.0, 0.0), Some(1));
        assert_eq!(display_at(&displays, 5000.0, 0.0), None);
    }

    #[test]
    fn regions_map_to_the_display_they_overlap_most() {
        let displays = [Rect { x: 0.0, y: 0.0, w: 1728.0, h: 1117.0 }, Rect { x: -1920.0, y: -200.0, w: 1920.0, h: 1080.0 }];
        let (i, clipped, local) = region_on_display(&displays, Rect { x: 100.0, y: 50.0, w: 200.0, h: 100.0 }).unwrap();
        assert_eq!((i, clipped, local), (0, Rect { x: 100.0, y: 50.0, w: 200.0, h: 100.0 }, Rect { x: 100.0, y: 50.0, w: 200.0, h: 100.0 }));
        // Mostly on the left display: clipped to it, sourceRect relative to its (-1920,-200) origin.
        let (i, clipped, local) = region_on_display(&displays, Rect { x: -500.0, y: 0.0, w: 600.0, h: 100.0 }).unwrap();
        assert_eq!(i, 1);
        assert_eq!(clipped, Rect { x: -500.0, y: 0.0, w: 500.0, h: 100.0 });
        assert_eq!(local, Rect { x: 1420.0, y: 200.0, w: 500.0, h: 100.0 });
        assert!(region_on_display(&displays, Rect { x: 9000.0, y: 0.0, w: 10.0, h: 10.0 }).is_none());
    }

    #[test]
    fn native_size_scales_points() {
        assert_eq!(native_size((1728.0, 1117.0), 2.0), (3456, 2234));
        assert_eq!(native_size((100.4, 50.0), 1.0), (100, 50));
        assert_eq!(native_size((10.0, 10.0), 0.0), (10, 10), "bad scale falls back to 1x");
    }
}
