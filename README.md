# Petfolio

A free fan-made tracker for **Pet Simulator 99**: RAP (recent average price) and exists counts for every tradeable pet and item, checked every 5 minutes, with price history charts, daily movers and market totals.

Data comes from the official [Pet Simulator 99 Public API](https://github.com/BIG-Games-LLC/ps99-public-api-docs) by BIG Games. Under the API's [terms](https://github.com/BIG-Games-LLC/ps99-public-api-docs/blob/master/TERMS.md) this site must stay **non-commercial** (no ads, donations or paid features) and must credit Pet Simulator 99 and its developers, which the footer does.

## How it works

- Every 5 minutes, GitHub Actions runs `update.mjs`. It downloads RAP and exists counts from the API, adds them to the saved history, and rebuilds the site.
- History is saved on a separate branch called `data`. That branch is replaced on each run, so the repository stays small.
- History keeps every RAP change at 5-minute detail for 7 days, one reading per 6 hours up to 30 days, and one per day after that. Exists-only changes are saved hourly.
- The website itself (`index.html`, `app.js`, `styles.css`, `shard.js`) is plain HTML, CSS and JavaScript. GitHub Pages hosts it for free.
- Every file sits at the top level of the repository (no folders except `.github`).

## One-time setup (about 10 minutes)

1. **Create a GitHub account** at <https://github.com/signup> (free).
2. **Create a repository.** Click **+** (top right) → **New repository**. Name it `petfolio`, choose **Public** (free GitHub Pages needs a public repo), tick **Add a README file**, and click **Create repository**.
3. **Upload the site files.** On the repository page click **Add file → Upload files**. Unzip `petfolio.zip`, open the `petfolio` folder, and drag in everything you see: the `site` and `scripts` folders, `package.json` and `README.md`. Click **Commit changes**.
4. **Add the hourly job.** Your computer hides the `.github` folder, so create it by hand: click **Add file → Create new file**, type `.github/workflows/update.yml` as the file name (the slashes create the folders), open `update.yml` (it sits next to the `petfolio` folder in the zip) in Notepad or TextEdit, paste its full contents in, and click **Commit changes**.
5. **Turn on GitHub Pages.** Go to **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
6. **Run the first update.** Go to the **Actions** tab, click **Update RAP data** on the left, then **Run workflow → Run workflow**. It takes 1 to 3 minutes. When it shows a green check, your site is live at:

   `https://<your-github-username>.github.io/petfolio/`

After that it updates itself every 5 minutes (GitHub's fastest schedule). GitHub sometimes starts scheduled runs a few minutes late.

## If something goes wrong

- **The run fails at "Save history to the data branch" with a permission error:** go to **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions**, save, and run it again.
- **The run fails at "Deploy" saying Pages isn't enabled:** repeat step 5, then run it again.
- **The run fails at "Pull the latest RAP":** the BIG Games API was down or slow. Nothing is lost; the next hourly run tries again.
- **GitHub emails that scheduled workflows were disabled:** open the Actions tab and click **Enable workflow**.

## Things to know

- Each item's RAP refreshes in the API on its own timer, so any one item's RAP often stays the same across several checks. Exists counts refresh about every minute in the API and every 5 minutes here.
- Charts, 24h and 7d changes, movers and sentiment fill in as history builds. 24h numbers appear after the first day; 7d after the first week.
- Bookmarks are saved in each visitor's own browser.
- Item pictures load from the API's official image service. Golden pets use their golden art, rainbow pets cycle colors and shiny pets get a sparkle, like in game. If a picture can't load, the item's first letter shows instead.

## Changing the site

Edit `index.html`, `app.js` or `styles.css` (layout and features) or `update.mjs` (what data is collected). Any change you commit rebuilds the site within a few minutes.

To try it on your own computer with Node.js 20+: `npm run update` (pulls live data into `store/`), then `npm run serve`.
