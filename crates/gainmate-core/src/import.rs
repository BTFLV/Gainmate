use crate::{
    analysis::supported,
    process::{check_cancel, Cancel},
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub paths: Vec<PathBuf>,
    pub warnings: Vec<String>,
}
pub fn collect(paths: &[PathBuf], cancel: &Cancel) -> Result<Imported> {
    let mut found = BTreeSet::new();
    let mut warnings = Vec::new();
    for path in paths {
        check_cancel(cancel)?;
        if path.is_dir() {
            for entry in WalkDir::new(path)
                .follow_links(false)
                .into_iter()
                .filter_entry(|e| !e.file_name().to_string_lossy().starts_with(".gainmate"))
            {
                check_cancel(cancel)?;
                match entry {
                    Ok(e) if e.file_type().is_file() && supported(e.path()) => {
                        match e.path().canonicalize() {
                            Ok(p) => {
                                found.insert(p);
                            }
                            Err(e) => warnings.push(e.to_string()),
                        }
                    }
                    Err(e) => warnings.push(e.to_string()),
                    _ => {}
                }
            }
        } else if !path.exists() {
            warnings.push(format!("Missing: {}", path.display()));
        } else if supported(path) {
            found.insert(path.canonicalize()?);
        } else {
            warnings.push(format!("Unsupported format: {}", path.display()));
        }
    }
    Ok(Imported {
        paths: found.into_iter().collect(),
        warnings,
    })
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RekordboxTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub path: Option<PathBuf>,
    pub missing: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub name: String,
    pub track_ids: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rekordbox {
    pub tracks: Vec<RekordboxTrack>,
    pub playlists: Vec<Playlist>,
}
pub fn parse_rekordbox(xml: &str) -> Result<Rekordbox> {
    anyhow::ensure!(xml.len() <= 128 * 1024 * 1024, "XML library exceeds 128 MB");
    let doc = roxmltree::Document::parse(xml).context("Invalid Rekordbox XML")?;
    let root = doc.root_element();
    anyhow::ensure!(
        root.tag_name().name() == "DJ_PLAYLISTS",
        "This is not a Rekordbox XML export"
    );
    let collection = root
        .children()
        .find(|n| n.has_tag_name("COLLECTION"))
        .context("Missing COLLECTION")?;
    let mut tracks = Vec::new();
    let mut locations = BTreeMap::new();
    for t in collection.children().filter(|n| n.has_tag_name("TRACK")) {
        let id = t.attribute("TrackID").unwrap_or_default().to_string();
        let location = t.attribute("Location").unwrap_or_default();
        let path = local_location(location);
        locations.insert(location.to_string(), id.clone());
        tracks.push(RekordboxTrack {
            id,
            title: t.attribute("Name").unwrap_or("Untitled").into(),
            artist: t.attribute("Artist").unwrap_or_default().into(),
            missing: path.as_ref().is_none_or(|p| !p.is_file()),
            path,
        });
    }
    let mut playlists = Vec::new();
    for node in root
        .descendants()
        .filter(|n| n.has_tag_name("NODE") && n.attribute("Type") == Some("1"))
    {
        let mut ancestors: Vec<_> = node
            .ancestors()
            .filter(|n| n.has_tag_name("NODE"))
            .filter_map(|n| n.attribute("Name"))
            .filter(|n| *n != "ROOT")
            .collect();
        ancestors.reverse();
        let location_keys = node.attribute("KeyType") == Some("1");
        let ids = node
            .children()
            .filter(|n| n.has_tag_name("TRACK"))
            .filter_map(|n| n.attribute("Key"))
            .filter_map(|k| {
                if location_keys {
                    locations.get(k).cloned()
                } else {
                    Some(k.to_string())
                }
            })
            .collect();
        playlists.push(Playlist {
            name: ancestors.join(" / "),
            track_ids: ids,
        });
    }
    Ok(Rekordbox { tracks, playlists })
}
fn local_location(location: &str) -> Option<PathBuf> {
    let url = url::Url::parse(location).ok()?;
    if url.scheme() != "file"
        || url
            .host_str()
            .is_some_and(|h| h != "localhost" && !h.is_empty())
    {
        return None;
    }
    let path = url.to_file_path().ok()?;
    Some(path)
}
pub fn read_rekordbox(path: &Path) -> Result<Rekordbox> {
    anyhow::ensure!(
        std::fs::metadata(path)?.len() <= 128 * 1024 * 1024,
        "XML library exceeds 128 MB"
    );
    parse_rekordbox(&std::fs::read_to_string(path)?)
}
