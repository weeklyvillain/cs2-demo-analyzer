//! 2D outline of an inferno's burning fires, ordered clockwise like
//! demoinfocs' `Fires.Active().ConvexHull2D()`.

use crate::util::*;
use source2_demo::prelude::*;
use std::cmp::Ordering;

pub fn inferno_hull(e: &Entity) -> Vec<[f64; 2]> {
    let origin = position(e);
    let n = p_i64(e, "m_fireCount").unwrap_or(0).clamp(0, 64);
    let mut pts: Vec<[f64; 2]> = Vec::with_capacity(n as usize);
    for i in 0..n {
        if !p_bool(e, &format!("m_bFireIsBurning.{:04}", i)).unwrap_or(false) {
            continue;
        }
        match p_vec3(e, &format!("m_firePositions.{:04}", i)) {
            Some(v) => pts.push([v[0] as f64, v[1] as f64]),
            None => {
                let dx = p_i64(e, &format!("m_fireXDelta.{:04}", i)).unwrap_or(0) as f64;
                let dy = p_i64(e, &format!("m_fireYDelta.{:04}", i)).unwrap_or(0) as f64;
                pts.push([origin[0] + dx, origin[1] + dy]);
            }
        }
    }
    let mut hull = convex_hull(pts);
    sort_clockwise(&mut hull);
    hull
}

fn cross(o: &[f64; 2], a: &[f64; 2], b: &[f64; 2]) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// Andrew's monotone chain; collinear points are dropped.
pub fn convex_hull(mut pts: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let mut lower: Vec<[f64; 2]> = Vec::new();
    for p in &pts {
        while lower.len() >= 2 && cross(&lower[lower.len() - 2], &lower[lower.len() - 1], p) <= 0.0
        {
            lower.pop();
        }
        lower.push(*p);
    }
    let mut upper: Vec<[f64; 2]> = Vec::new();
    for p in pts.iter().rev() {
        while upper.len() >= 2 && cross(&upper[upper.len() - 2], &upper[upper.len() - 1], p) <= 0.0
        {
            upper.pop();
        }
        upper.push(*p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Same ordering as demoinfocs' `sortPointsClockwise` (around the bounding
/// box centre).
pub fn sort_clockwise(points: &mut [[f64; 2]]) {
    if points.is_empty() {
        return;
    }
    let (mut min_x, mut max_x, mut min_y, mut max_y) =
        (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for p in points.iter() {
        min_x = min_x.min(p[0]);
        max_x = max_x.max(p[0]);
        min_y = min_y.min(p[1]);
        max_y = max_y.max(p[1]);
    }
    let c = [0.5 * (min_x + max_x), 0.5 * (min_y + max_y)];
    let less = |a: &[f64; 2], b: &[f64; 2]| -> bool {
        let (ax, ay, bx, by) = (a[0] - c[0], a[1] - c[1], b[0] - c[0], b[1] - c[1]);
        if ax >= 0.0 && bx < 0.0 {
            return true;
        }
        if ax < 0.0 && bx >= 0.0 {
            return false;
        }
        if ax == 0.0 && bx == 0.0 {
            if ay >= 0.0 || by >= 0.0 {
                return a[1] > b[1];
            }
            return b[1] > a[1];
        }
        let det = ax * by - bx * ay;
        if det < 0.0 {
            return true;
        }
        if det > 0.0 {
            return false;
        }
        ax * ax + ay * ay > bx * bx + by * by
    };
    points.sort_by(|a, b| {
        if less(a, b) {
            Ordering::Less
        } else if less(b, a) {
            Ordering::Greater
        } else {
            Ordering::Equal
        }
    });
}
