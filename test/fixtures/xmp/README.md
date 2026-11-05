These small, synthetic fixtures use publicly documented XMP property and packet shapes; they contain no photographs or exported user metadata.

- `lightroom.xmp`: Adobe XMP packet/RDF structure and Camera Raw namespace, scalar adjustments, tone curves, and structured look. [XMP specification](https://developer.adobe.com/xmp/docs/XMPSpecifications/), [Camera Raw namespace](https://exiftool.org/TagNames/XMP.html#crs).
- `darktable.xmp`: extension-preserving sidecar naming, `darktable` namespace, history sequence and compressed parameter strings. [Sidecar files](https://docs.darktable.org/usermanual/development/en/overview/sidecar-files/), [XMP tags](https://exiftool.org/TagNames/XMP.html#darktable). Parameter bytes are placeholders, not a usable processing history.
- `capture-one.xmp`: standard rating, label, keyword bag and rights alternative. Capture One synchronizes these fields in XMP; its RAW adjustments normally live in separate `.cos`/catalog files. [Metadata in XMP sidecar files](https://support.captureone.com/hc/en-us/articles/360002544898-Metadata-in-XMP-sidecar-files). The instructions field exercises CDATA preservation.

The fixtures test interoperability of file shapes and preservation, not rendering in those applications.
