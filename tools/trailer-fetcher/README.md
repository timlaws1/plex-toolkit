# Trailer Fetcher

Polls [TrailerAddict](https://traileraddict.com/) for new trailer RSS entries, enriches each title with TMDb (genres, certificate, release date), downloads the MP4 into a folder on disk, and deletes files after a configurable number of days following the film’s release date.

This tool does **not** play trailers or build preroll sequences — [Preroll Scheduler](../preroll-scheduler/) still owns selection and ordering.

## Setup

1. Enable **Trailer Fetcher** on the Tools page.
2. Add your TMDb key on the **API keys** page ([TMDb API settings](https://www.themoviedb.org/settings/api)). It is shared with the other tools.
3. In settings:
   - Set **Certificate region** (default `GB`) for rating lookups.
   - Set **Download folder** to an absolute path under `MEDIA_ROOTS` (same roots Preroll Scheduler uses for bucket scans).
4. In **Preroll Scheduler**, add a **Bucket** pointing at that same download folder.
5. Add that bucket as a **Step** on whichever schedule should include new trailers.

On each poll, new RSS items are downloaded into the folder. Preroll Scheduler picks them up the next time you rescan the bucket (or on its normal scan cycle). After the film’s TMDb release date plus **Days to keep after release** (default 7), the file is removed from disk; Preroll Scheduler will mark it missing on the next bucket scan.

## Notes

- When **Trailer Fetcher** and **Preroll Scheduler** are both enabled, prerolls regenerated at movie start (and **Roll Again** while that session context is remembered) prefer bucket videos whose stored TMDb certificate matches the feature’s Plex content rating (BBFC-normalised). Manual bucket files without a fetcher record are still eligible.
- Trailers with no TMDb match (no release date) are kept until you remove them manually; the hourly cleanup job logs a warning listing those titles.
