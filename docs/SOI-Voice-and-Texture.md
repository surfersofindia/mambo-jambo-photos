# Surfers of India — Human Voice, Analog Texture & Micro-interactions

Everything below is **applied in the working tree** (not deployed, not committed). The tables double as the review checklist: reject a row and revert that string.

## 1 · The Human Microcopy Dictionary

Voice: surfers talking to surfers. Sun-bleached, confident, zero-bullshit.

1. **One breath per string.** If it takes two sentences to explain, cut one. Buttons ≤ 3 words.
2. **Surf reality, not machine talk.** Never: AI, facial recognition, matching service, face-processing, algorithm, verification, index(ed/ing) — except in the admin where the crew needs the real word. Say: "find your waves", "scan the lineup", "your face finds your photos".
3. **No filler.** Banned: seamlessly, securely (say what actually happens instead), leverage, elevate, experience, cutting-edge, state-of-the-art, instantly, organise, memories/moments as a noun for photos (say waves, shots, photos), "please" at the end of every error.
4. **Plain and honest on privacy.** Short but true: "Your selfie finds your photos, then it's gone. We never keep it."
5. **No emoji in buttons. No "↗" on every link.** One arrow on the primary CTA is plenty.
6. **Numbers stay concrete.** "₹700", "12 waves", "3 of 300 failed" — never "a few", never "some".
7. **Sentence case.** Eyebrows may be tracked caps, nothing else. Kill the "01 /" numbering on eyebrows.
8. **Errors: what happened + what to do, ≤ 12 words.** "That took too long. Go again?"
9. **Admin voice = the same person, before coffee.** Terse, specific, no exclamation marks except "Live."


 — Before → After (apply verbatim; extend everything else in the same voice)

### Public — hero & nav
| Before | After |
|---|---|
| nav: How it works · Pricing · The sessions · Find my photos ↗ | How it works · Price · Sessions · Find my waves |
| SALT WATER · BIG GRINS · MADE IN INDIA | (keep) |
| Your waves. Your memories. | You surfed it. We shot it. |
| Two surfers who film everything. From lineups to the people who chase them. Find your moments from the Indian coast, one session at a time. | Two surfers, two cameras, every session on the coast. Your shots are in here somewhere. |
| Find my surf photos ↗ | Find my waves → |
| One selfie. Your session. All the good stuff. | One selfie. Done. |
| PHOTOS · FILMS · THE INDIAN COAST / A LITTLE PIECE OF THE OCEAN TO TAKE HOME. | PHOTOS · FILMS · THE INDIAN COAST / TAKE THE OCEAN HOME. |

### Public — finder
| Before | After |
|---|---|
| 01 / FIND YOURSELF | FIND YOURSELF |
| Your next favourite photo is *in here.* | Your best wave is *in here.* |
| No endless folders. Just choose when you surfed and let a clear selfie help us find your shots. | Pick the day. Drop a selfie. We'll dig out your shots. |
| Your face. Your choice. / Your selfie is sent securely to our matching service for processing. This app does not save the selfie. How matching works | Your face stays yours. / Your selfie finds your photos, then it's gone. We never keep it. How it works |
| Steps: 01 Session · 02 Selfie · 03 Your photos | Session · Selfie · Your shots (keep the numbers only as the small step index) |
| Welcome back — your unlocked photos from X are still here. / Open my unlocked photos → | Welcome back. Your photos from X are still here. / Open my photos |
| BACK TO THAT DAY / When did you surf? / Find your day in the water. We'll take it from there. | (keep) / When did you surf? / Pick your day in the water. |
| Find a session / Search a date, session or beach | Find a session / Date, beach or session name |
| Choose your surf session (legend) | Your session |
| Finding your days in the water… | Pulling up the sessions… |
| No sessions match. Try a different date or beach. | Nothing on that day. Try another date or beach. |
| Try loading sessions again ↻ | Try again |
| Choose a session → (disabled) / Continue with this session → | Pick a session / That's the one → |
| Next up: one clear selfie to find your photos. | Next: one clear selfie. |
| Show us your surf face. / A bright, front-facing selfie. Just you, without sunglasses. | Show us your face. / Good light, no sunnies, just you. |
| ＋ Choose a selfie / JPG, PNG or WebP · up to 10 MB | ＋ Drop a selfie / JPG, PNG or WebP · up to 10 MB |
| 📷 Take a selfie now | Snap one now |
| I consent to sending my selfie to the face-matching service to find my photos. Read the privacy details. | Match my face against this session's photos. My selfie isn't kept. Privacy details |
| Find my photos ↗ (submit) | Find my waves |
| Looking for your moments. / We're comparing your selfie with this session's photos. This may take a little while. / Cancel search | Scanning the lineup… / Give us a sec. / Stop |

### Public — status lines (app.js)
| Before | After |
|---|---|
| Loading available sessions… | Loading sessions… |
| Matching your selfie… | Scanning… |
| Choose a JPG, PNG or WebP image smaller than 10 MB. | JPG, PNG or WebP under 10 MB. |
| That image couldn't be opened. Please choose another photo. | Couldn't open that one. Try another. |
| The search took too long. Please try again. | That took too long. Go again? |
| Search cancelled. You can try again when you're ready. | Stopped. Whenever you're ready. |
| Loading took too long. Please try again. | Took too long. Try again? |
| We couldn't load your sessions. / We couldn't load the sessions. Use "Try loading sessions again" above to retry. | Sessions didn't load. / Sessions didn't load — hit Try again above. |
| Your crew hasn't published any sessions yet. Check back soon. | Nothing published yet. Check back after your surf. |
| Your next surf session will appear here once the crew publishes it. / The next batch of memories is on its way. Check back after your session. | Nothing published yet. / Next session drops after the next swell. |
| Photo search is not available yet. Please check back soon. | Photo search is down right now. Back soon. |
| We couldn't complete that request. Please try again. | That didn't work. Try again? |
| The search response was incomplete. Please try again. | Something came back broken. Go again? |
| An invalid photo link was returned. Please try again. | Bad photo link. Try again? |
| Your gallery could not be opened. | Couldn't open your photos. |
| … If you paid and can't reach your photos, email namaste@… with your mobile number. | … Paid and locked out? Email namaste@surfersofindia.com with your number. |

### Public — results & lightbox
| Before | After |
|---|---|
| N moments. All yours. | N waves. All you. |
| A little salt, a little sunshine, and you. Tap a photo for a closer look. | Tap one to get closer. |
| No matches this time. / Try a brighter selfie without sunglasses, or check that you chose the right session. | No waves with your face in them. / Brighter selfie, no sunnies — or check the session. |
| You're viewing watermarked previews. Unlock full-resolution downloads below. | These are previews. Unlock the originals below. |
| Payment received — these are your original, watermark-free photos. Tap a photo, then use Download original. This browser will remember your unlocked gallery for 30 days. | Paid. These are the originals — tap one, then Download. They stay here for 30 days. |
| Unlock N photos ₹700 (button) | Unlock all photos · ₹700 (the count lives in the title) |
| ♡ Favourites 0 | ♡ Keepers 0 |
| No favourites yet. Tap the heart on a photo to keep it here. | No keepers yet. Tap ♡ on a wave. |
| MOMENT 01 · PREVIEW / ORIGINAL | WAVE 01 · PREVIEW / ORIGINAL |
| Enlarge photo N (aria) / Favourite photo N (aria) | Open wave N / Keep wave N |
| Watermarked preview / Original · full resolution | Preview / Original |
| Download original ↓ / Download ↓ | Download |
| Swipe to browse · tap to zoom · pinch to zoom closer | Swipe · double-tap to zoom |
| ← → to browse · click the photo to zoom | ← → · double-click to zoom |
| This photo link has expired… / Photo N could not load — tap to retry | Photo N didn't load — tap to retry |
| ← Back to your search | ← Back |

### Public — checkout (copy only; Cashfree logic untouched)
| Before | After |
|---|---|
| Almost there. / Add your mobile number to pay securely with Cashfree. | Almost yours. / Your number, then UPI, card or netbanking. |
| Email (optional, for your receipt) | Email (optional, for the receipt) |
| Enter a valid 10-digit mobile number. | Needs a 10-digit mobile number. |
| Creating your payment… / Confirming your payment… | Setting up payment… / Confirming… |
| Payment was not completed. You can try again. | Payment didn't go through. Try again? |
| Payment could not start. Please refresh and try again. / The payment service could not be loaded. Check your connection and try again. | Payment didn't start. Refresh and try again. / Couldn't reach the payment service. Check your connection. |
| Payment confirmed, but photos could not be loaded. Contact the crew with your payment details. | Paid, but the photos didn't load. Email the crew with your payment details. |
| We received your payment. / Confirming your payment… / Payment received. / Payment received, but… | Payment received. / Confirming… / Paid. / Paid, but… |
| Order X came back, but this browser has no record of your search, so the photos can't be opened here. Return to the tab where you searched, or email namaste@… with your mobile number and this order ID and the crew will send your photos. | Order X is paid, but this browser doesn't know your search. Go back to the tab you searched in, or email namaste@surfersofindia.com with your number and order X. |

### Public — how / price / sessions / privacy / footer
| Before | After |
|---|---|
| 02 / FROM SEA TO SCREEN / Less searching. *More reliving.* / You focus on the waves. We'll take care of the memories. | HOW IT WORKS / Less searching. *More surfing.* / You surf. We shoot. |
| We get the shot. / Our crew captures the little victories and the glorious wipeouts along the way. | We shoot the session. / Every wave. Every wipeout. |
| You bring a selfie. / Pick your session and upload a clear photo of yourself. We'll look for familiar faces. | You drop a selfie. / Pick your day, show your face. |
| Meet your memories. / Browse your matched previews and keep your favourites together while you explore. | You get your waves. / Previews first. ₹700 for the originals. |
| 03 / WHAT IT COSTS / One price. *Every wave you're in.* / No subscriptions, no bundles you don't need. Pay once, keep everything we found of you. | THE PRICE / (keep) / Pay once. Keep every photo you're in. |
| Full-resolution photo pack / Every photo we matched to your selfie from that session — full resolution, no watermark, yours to keep. | Your session pack / Every shot of you from that session. Full-res, no watermark, yours. |
| All your matched photos in one pack / Instant unlock after payment / Pay securely by UPI, card or netbanking via Cashfree | Everything we found of you / Unlocks the second you pay / UPI, cards, netbanking |
| 04 / GOOD TIMES, ON RECORD / Fresh from *the water.* / Find your session ↗ / Loading recent sessions… / `${location} · Find your photos` | LATEST SESSIONS / (keep) / Find yours / Loading… / `${location}` |
| A NOTE ON YOUR PRIVACY / A little trust goes a long way. | PRIVACY, PLAINLY / (keep) |
| With your consent, your selfie is uploaded to our API and forwarded to the face-processing service. The app uses the resulting face data to compare against your selected session. The selfie and its face data are not saved by this app. | Your selfie goes to our servers, gets compared with the session you picked, and is dropped. We don't keep it or its face data. |
| Session photos and their face data are stored for matching. A search record containing matched photo IDs is created, and preview access is temporary. Matching can make mistakes. Only upload your own selfie; contact namaste@… for help with incorrect matches or data requests. | Session photos and their face data stay stored so matching works. We keep a record of which photos matched you; preview links expire. Matching isn't perfect — only upload your own face, and email namaste@surfersofindia.com if something's wrong or you want your data gone. |
| Footer: Surfers of India ↗ · Instagram ↗ · Say hello · Privacy · About · Contact · Terms · Refunds · Crew login ↗ | Surfers of India · Instagram · Say hello · Privacy · About · Contact · Terms · Refunds · Crew |

### Admin — login, chrome, tabs
| Before | After |
|---|---|
| BACKSTAGE ACCESS / Your next session starts here. / Sign in to upload a session, organise photos and review matches. | CREW ONLY / Morning, crew. / Sign in to drop today's session. |
| Enter your crew password (placeholder) / Enter studio → | Password / Let's go |
| ← Back to site | ← Site |
| SURFERS OF INDIA / CREW STUDIO (eyebrow) / The coast. Captured. | CREW STUDIO / Drop the session. |
| 01 Upload photos · 02 Sessions · 03 Review matches | Upload · Sessions · Review |
| Your crew session expired. Please sign in again. | Signed out — sign in again. |
| Too many sign-in attempts. Please wait 15 minutes. / Incorrect password. / Cannot reach the photo service. Check your connection and try again. / Sign-in took too long. Please try again. | Too many tries. Wait 15 minutes. / Wrong password. / Can't reach the photo service. Check your connection. / Sign-in timed out. Try again? |
| You will be signed out in 2 minutes. Move the mouse or tap to stay in. / Signed out after 30 minutes of inactivity. | Signing you out in 2 min — tap anything to stay. / Signed out — you'd gone quiet for 30 min. |

### Admin — upload
| Before | After |
|---|---|
| A fresh set of memories. / Fill in the session details, drop all the photos, then publish. | New session. / Name it, drop the photos, publish. |
| Session name / Session date / Beach / break / Photo-pack price (₹) · standard ₹700 | Session / Date / Break / Pack price (₹) |
| Drop today's session here / Photos are uploaded instantly and indexed in the background. Guests see watermarked previews and can unlock full-resolution originals through Cashfree. JPG, PNG, WebP or HEIC · RAW isn't accepted — export JPGs from Lightroom first. | Drop today's photos / JPG, PNG, WebP or HEIC. No RAW — export JPGs first. |
| Choose photos ↑ / Publish photo pack → / Cancel upload | Pick photos / Publish / Stop |
| N photos selected. Click "Publish photo pack" to upload. | N photos ready. Hit Publish. |
| N photos selected. M file(s) were left out (only JPG, PNG or WebP up to 25 MB): … Click "Publish photo pack" to upload the rest. | N ready. M left out (JPG, PNG, WebP or HEIC up to 25 MB): … |
| Choose only JPG, PNG or WebP photos up to 25 MB each. Remove unsupported files and select again. | JPG, PNG, WebP or HEIC up to 25 MB each. |
| Choose at least one photo before publishing. | Drop at least one photo first. |
| Uploading N photos… / Publishing… | Uploading N photos… / Publishing… |
| Published! Your session is live. Open Sessions to follow photo processing. | Live. Faces are indexing — watch it in Sessions. |
| Published! N of M photos are live. K upload(s) failed — open Sessions → "Upload more" on this session to retry. … | Live with N of M. K failed — Sessions → Add photos to retry. |
| All N upload(s) failed. The draft is still private; open Sessions to review or delete it. … | All N failed. The draft is still private — check Sessions. |
| Upload stopped — N of M photos are in the draft session; open Sessions to publish or add the rest. | Stopped. N of M are in the draft — publish or add the rest from Sessions. |
| Upload stalled — no data for 30 s. / Upload timed out. / Network error. / Upload cancelled. | Stalled — nothing sent for 30 s. / Timed out. / Network dropped. / Stopped. |
| HEIC could not be decoded in this browser — use Safari, or export JPEGs first. | This browser can't read HEIC — use Safari or export JPEGs. |
| Clear selection / Clear list / Remove | Clear / Clear / Remove |
| Waiting to upload / Uploading… / Uploaded / Upload failed / Skipped / Already in session / Saved as X / Replaced existing / Not sent | Waiting / Sending… / Sent / Failed / Skipped / Already here / Saved as X / Replaced / Not sent |

### Admin — sessions
| Before | After |
|---|---|
| Your sessions. / See what's published, what's processing and what needs attention. | Sessions. / (delete the subline) |
| Ready photos / Need attention / Total Photos / Active Sessions | Indexed / Need a look / Photos / Live |
| ✓ Indexing Complete / Indexing (45%) / ⚠️ N Failed / No Photos Uploaded / 45% Indexed | Indexed / Indexing · 45% / N failed / Empty / 45% indexed |
| Date / Location / Indexing Progress / Need attention (card stats) | Date / Break / Indexed / Failed |
| 📷 View Photos (N) / ⬆ Upload more / ✏️ Edit / ↻ Re-index all / ↻ Retry N failed / Publish session / Restore to draft / More ⋯ | Photos (N) / Add photos / Edit / Re-index / Retry N failed / Publish / Restore / More |
| Processing… (re-index disabled) / Adding to queue… / Queuing… / Publishing… / Restoring… / Deleting… | Indexing… / Queuing… / Queuing… / Publishing… / Restoring… / Deleting… |
| No sessions yet. Go to the Upload tab to create one. | No sessions yet. Upload one. |
| ✓ "X" is live for guests. | "X" is live. |
| N photos queued. M already processing. K could not be queued; retry those after processing finishes. You can leave this page; processing continues in the background. | N queued, M already running. K couldn't queue — retry after. You can leave, it keeps going. |
| N failed photo(s) queued again. M could not be queued. | N queued again. M couldn't queue. |
| Wait for the current upload to finish before adding more photos. | Let this upload finish first. |
| Delete this whole session? / "X" and all N of its photos will be removed from storage permanently, including originals guests have paid for. This cannot be undone. / Type "X" to confirm / Delete session | Delete "X"? / All N photos go — including originals people paid for. No undo. / Type "X" to confirm / Delete |
| Delete this photo? / X and its face data will be removed from storage permanently. Guests who already unlocked it will lose access. / Delete photo | Delete this photo? / Gone for good — including for anyone who paid for it. / Delete |
| Discard changes? / You have unsaved edits to this session. / Discard | (keep) |
| Stop uploading? / Photos already uploaded stay in the draft session. You can add the rest later with "Upload more". / Stop upload | Stop uploading? / What's sent stays in the draft. Add the rest later. / Stop |
| Edit session details / Title / Date / Location / Price (₹) / Status / Save Changes | Edit session / Session / Date / Break / Price (₹) / Status / Save |
| Session Photos / Photos — X / Loading session photos... / No photos uploaded to this session yet. | Photos / X / Loading… / Nothing here yet. |
| The landing page shows the brand illustration for this session until you pick a cover. Choose a lineup or wave shot — covers are public, so avoid photos where surfers are recognisable. | Pick a cover for the site — a lineup or wave shot, nothing with a recognisable face. Until then it shows the wave illustration. |
| ★ Cover / ☆ Use as cover / ✓ Cover updated. It appears on the landing page within a few minutes. / Cover removed — the landing page shows the illustration again. | ★ Cover / Set as cover / Cover set — on the site in a few minutes. / Cover removed. |
| N faces detected / No clear faces detected in this photo. / Queued or processing. Refresh to check progress. | N faces / No clear face. / Indexing — refresh to check. |

### Admin — add photos (upload more)
| Before | After |
|---|---|
| Upload more photos / Upload more — X / Checking your selection… | Add photos / Add photos — X / Checking… |
| N photos selected. M already exist in this session; K are new. / None of them are in this session yet. / R repeated file(s) in your selection were dropped. | N photos. M already here, K new. / All new. / R duplicates in your pick dropped. |
| Selected photos · M already in this session | Photos · M already here |
| What should happen with the duplicates? / Replace the existing photos — The new file overwrites… / Upload only the new photos — Duplicates are left out… / Keep both as a copy — Duplicates are uploaded with a numbered name, for example IMG_0412-2.jpg. | Same names again — what now? / Replace — new file wins, faces re-index. / Skip — leave the old ones alone. / Keep both — saved as IMG_0412-2.jpg. |
| Upload photos → / Upload N photos → / Nothing to upload / Retry failed uploads / Retry N failed upload(s) / Send N remaining photos / Done | Upload / Upload N / Nothing to upload / Retry failed / Retry N / Send N remaining / Done |
| N photos uploaded and queued for face indexing. M existing photos replaced. … K duplicates skipped. J uploads failed — … | N sent, indexing. M replaced. … K skipped. J failed — … |
| The existing photos could not be checked. | Couldn't check what's already here. |

### Admin — review
| Before | After |
|---|---|
| Crew Match Verification / Review possible matches and record your crew's decisions. Face-pair reviews train the scoring only; burst & appearance links you confirm below do reach guests. Keyboard: Y same, N different, S skip. | Second opinions. / Same surfer or not? Face pairs only train the scoring; burst & kit links below do show to surfers. Y same · N different · S skip. |
| 🔍 Rescan Borderline Matches / ↻ Refresh Queue / 🧠 Retrain from Reviews | Find borderline pairs / Refresh / Retrain scoring |
| Ready to review / Confirmed Matches / Dismissed / Rejected | To review / Same / Different |
| Looking for uncertain face pairs… / No uncertain face pairs available. Once photos finish processing, scan again to find pairs for review. | Looking for borderline pairs… / Nothing borderline right now. Scan again once indexing finishes. |
| A SECOND PAIR OF EYES / Same person, different moment? / Similarity 71% · Near the matching cutoff | (keep) / Same surfer? / 71% · borderline |
| FACE A / FACE B / Loading face… / Loading isolated face crops… / Compare the faces, then choose below. / A face could not load. Refresh the queue to try again. / Photo could not load | (keep) / (keep) / Loading… / Loading faces… / Your call. / A face didn't load — refresh the queue. / Didn't load |
| Zoom both faces / Reset / ✓ Same person / ✕ Different people / Not sure · skip | Zoom / Reset / Same / Different / Skip |
| No more pairs in this batch. Refresh to return to skipped pairs. | Batch done. Refresh to see skipped ones. |
| ✓ Borderline scan complete! Found N candidate pair(s) for verification. | Scan done — N borderline pairs. |
| Burst & Appearance Matches / Photos with no clear face, linked to a confirmed shot by burst timing or clothing appearance. Confirming a link lets guests find these photos automatically; pending links never do. | Same shot, no face. / No clear face, but shot seconds apart or same kit as a confirmed one. Confirm and the surfer gets it too. |
| 🔍 Scan Burst & Appearance Links / Confirmed Links | Find links / Confirmed |
| Looking for burst and appearance links… / No burst or appearance links available. Photos need capture timestamps — re-index a session, then scan again. | Looking for links… / No links yet. Needs capture times — re-index, then scan. |
| BURST SEQUENCE · Shot moments apart / SIMILAR OUTFIT · Matching clothing colors / Same person, different shot? / N% confidence | BURST · seconds apart / SAME KIT · matching colours / Same surfer? / N% |
| ✓ Scan complete! Found N candidate link(s) for verification. | Scan done — N links. |
| Fallback-match scoring trained on N reviews / ✓ Fallback-match scoring retrained on N reviews. / Not enough reviewed pairs yet (N so far) — keep reviewing the queues above, then retrain again. | Scoring trained on N reviews / Retrained on N reviews. / Only N reviewed so far — needs 20. Keep going. |
| N saved pair(s) cannot be shown yet because face crops are missing or their photos are still processing. Re-index the affected sessions, wait for processing to finish, then scan again. | N pairs hidden — faces still indexing or crops missing. Re-index, wait, scan again. |



### Strings rewritten beyond the dictionary (applied in the working tree)

| Where | Before | After |
|---|---|---|
| index.html · hero scroll link | Scroll to find your photos | Scroll to find your waves |
| index.html · selfie preview alt | Your selected selfie | Your selfie |
| index.html · lightbox prev/next | Previous photo / Next photo | Previous wave / Next wave |
| index.html · checkout dialog aria | Unlock your photos | Unlock the originals |
| index.html · noscript | Enable JavaScript to load sessions and find your photos. | Turn on JavaScript to load sessions and find your waves. |
| app.js · latest badge | Latest session | Latest |
| app.js · tile alt | Surf session preview N | Wave N preview |
| app.js · tile download aria | Download original photo N | Download wave N |
| app.js · lightbox alt | Enlarged surf photo preview N of M | Wave N of M, preview |
| app.js · resume gallery | These are your original, watermark-free photos. | The originals, still here. Tap one, then Download. |
| app.js · redirect error tail | …Email namaste@… with your mobile number if this persists. | …Still stuck? Email namaste@surfersofindia.com with your number. |
| admin.js · API fallback | Something went wrong. | That didn't work. Try again? |
| admin.js · login service down | The photo service is unavailable. Please try again. | Photo service is down. Try again? |
| admin.js · decode failure | Could not read image. | Couldn't read this file. |
| admin.js · empty drop | No valid images selected… | No photos in that pick. JPG, PNG, WebP or HEIC. |
| admin.js · leave guard | N selected photos haven't been published yet and will be dropped. | N photos not published yet — leaving drops them. |
| admin.js · bad 2xx | Invalid upload response. | Bad reply from the photo service. |
| admin.js · ETA placeholder | calculating... | starting… |
| admin.js · tab-title flags | ✓ Published · Crew Studio | Live · Crew Studio |
| admin.js · disabled tooltips | Upload at least one photo before publishing. / Restore this archived session before uploading more photos. | Add photos first. / Archived — restore it first. |
| admin.js · retrain, one label only | (lumped into "not enough") | N reviewed, but all one answer — needs some of each. |
| admin.html · retrain tooltip | Refit fallback-match scoring from every confirmed/rejected review so far | Refit the scoring from every Same / Different call so far |
| admin.html · confirm fallbacks | Are you sure? / Type the session name to confirm | Sure? / Type the name to confirm |
| about/terms/refunds · body | face-matching service, full-resolution, watermark-free, securely, instantly, moments | matched, the originals, unwatermarked, "paid through Cashfree by UPI, card or netbanking", "the moment your payment is confirmed", shots |


## 2 · CSS "Analog Texture & Linocut" snippet

Lives in `soi-tokens.css` (shared by both pages, loaded first). Drop-in: the tokens in `:root` plus the classes below; page files consume them.

```css
/* :focus-visible lives in the Analog texture section below (terracotta ring + linen halo, both pages) */

/* Display type: headings get the serif, everything else stays sans */
h1,h2{font-family:var(--display);font-weight:500;letter-spacing:-.01em}
h1 em,h2 em{font-style:italic;font-weight:500;color:var(--soi-coral-deep)}   /* pink = the emotional beat */
.eyebrow{color:var(--soi-slate-deep)}                                           /* blue = information */
```

**Where it's applied:** organic-sm radius + hard 2 px stamp shadow (`3px` on hover, `1px` + 1 px press on `:active`) on `.button`, `.nav-cta`, `.publish-btn`, `.choose-btn`, `.filter-button`, `.lightbox-download`, `.btn-primary-sm`, `.confirm-btn`; organic card radius on `.photo-open`, `.session-card img`, `.finder-card`, `.pricing-card`, `.upload-zone`, `.soi-empty`, `.d-card`, `.metric-card`, `.verify-card`, `.drop-zone`; `--radius-chip` is now organic-sm so no 999 px pills remain; grain via `body::before`; `.soi-stamp` weight on `.hero-stamp`, `.stamp-corner`, `.soi-empty svg`, toast icons; `.soi-stamp--ink` on the login hibiscus; the "how it works" grid is staggered (+40 px / +80 px) and the session grid runs as a contact sheet.

## 3 · Micro-interactions (`soi-fx.js`, 6.1 KB, zero dependencies)

Loaded deferred before `app.js` / `admin.js`; every call site is optional-chained (`window.SOI?.haptic?.([15])`).

| API | Behaviour |
|---|---|
| `SOI.haptic(pattern = [15])` | `navigator.vibrate` — only when the last pointer was a finger **and** `(hover:none)`; never throws. Wired: keeper toggle [15], photo open/swipe [10], selfie chosen [20], payment confirmed [30,40,30], admin review Same/Different/Skip [12], publish success [15]. |
| `SOI.splash({ at, symbol, count, color, spread, duration })` | Linocut stamp burst (WAAPI: outward arc, ±120° spin, scale .4→1→.8, fade; 0–120 ms stagger). `at` = Element (measured a frame later, after smooth scroll) or viewport `{x,y}`. Appends inside an open `<dialog>` so it paints above the top layer. No-op under reduced motion. Wired: hibiscus ×6 on results with matches, sunburst ×12 on payment confirmed, sunburst ×12 on publish "Live.", sunburst ×8 on add-photos done, coconut ×5 on cover set. |
| `SOI.underline(el, { color, delay })` | Hand-drawn wobbly SVG underline (3–4 quadratic segments, jitter seeded from the text so it's stable per label), 600 ms draw-in, re-measured on resize and `fonts.ready`. Auto-runs on every `.soi-underline` at load. Wired: "₹700" in pricing, the match count in "12 waves. All you." |
| Lightbox | iOS-style: **double-tap / double-click** zooms 2.2× at the point (320 ms spring), again to reset; pinch 1–4×; drag to pan while zoomed (clamped); 40 px swipe changes photo; single tap does nothing. |
| Toasts (admin) | `.soi-toast` stack with stamp icons, explicit kinds (`info`/`success`/`error`), 5 s / 9 s auto-dismiss, reparented into an open dialog so they're never hidden by a backdrop. |

```js
/* soi-fx.js — Surfers of India micro-interactions, no deps, ≤6 KB. window.SOI = { version, haptic, splash, underline }.
   Deferred before app.js / admin.js; each entry point swallows its own errors, so old browsers get no-ops. */
(() => {
  'use strict';
  const SOI = window.SOI = window.SOI || {};
  SOI.version = '1';
  const R = Math.random, EASE = 'cubic-bezier(.22,1,.36,1)'; // = --ease-out
  const INK = ['terracotta', 'slate-deep', 'coral-deep', 'ochre']; // --soi-* colours, cycled
  const still = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches || !Element.prototype.animate; } catch { return true; } };
  const svgEl = tag => document.createElementNS('http://www.w3.org/2000/svg', tag);

  // haptic: desktop Chrome exposes vibrate() too, so gate on "last pointer was a finger" AND a hover-less device
  let touched = false;
  addEventListener('pointerdown', e => { touched = e.pointerType === 'touch'; }, { capture: true, passive: true });
  SOI.haptic = (pattern = [15]) => {
    try { return !!(touched && matchMedia('(hover:none)').matches && navigator.vibrate(pattern)); } catch { return false; }
  };

  // splash: linocut stamps burst from an Element (measured a frame later, after a smooth scroll settles) or viewport {x,y}.
  // Nothing outside the top layer paints over an open dialog, so the layer goes inside it (absolute: a transform would misplace fixed).
  const tr = (x, y, r, s) => `translate(${x}px,${y}px) rotate(${r}deg) scale(${s})`;
  function burst({ at, symbol = 'stamp-sunburst', count = 10, color, spread = 90, duration = 900 }, resolve) {
    let x, y, r, host = document.querySelector('dialog[open]');
    if (at?.getBoundingClientRect) { r = at.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
    else if (typeof at?.x === 'number') { x = at.x; y = at.y; }
    else { x = innerWidth / 2; y = innerHeight / 2; }
    const layer = document.createElement('div');
    layer.className = 'soi-splash'; layer.setAttribute('aria-hidden', 'true');
    if (host) { r = host.getBoundingClientRect(); x += host.scrollLeft - r.left - host.clientLeft; y += host.scrollTop - r.top - host.clientTop; layer.style.position = 'absolute'; }
    else host = document.body;
    let left = count;
    const done = () => { if (--left <= 0 && layer.parentNode) { layer.remove(); resolve(); } };
    for (let i = 0; i < count; i++) {
      const size = 14 + Math.round(R() * 12), s = svgEl('svg'), u = svgEl('use');
      const a = i / count * Math.PI * 2 + (R() - .5) * .7, d = spread * (.55 + R() * .65);
      const dx = Math.cos(a) * d, dy = Math.sin(a) * d, rot = R() * 240 - 120;
      u.setAttribute('href', `soi-stamps.svg#${symbol}`); s.appendChild(u);
      s.style.cssText = `left:${x - size / 2}px;top:${y - size / 2}px;width:${size}px;height:${size}px;color:${color || `var(--soi-${INK[i % 4]})`}`;
      layer.appendChild(s);
      // lifts a little on the way out, then sags: thrown, not radiated
      const anim = s.animate([{ transform: tr(0, 0, 0, .4), opacity: 1 }, { transform: tr(dx * .72, dy * .72 - 12, rot * .6, 1), opacity: 1, offset: .45 }, { transform: tr(dx, dy + 16, rot, .8), opacity: 0 }],
        { duration, delay: R() * 120, easing: EASE, fill: 'forwards' });
      anim.onfinish = anim.oncancel = done;
    }
    host.appendChild(layer);
    setTimeout(() => { left = 0; done(); }, duration + 400); // hidden tabs pause WAAPI
  }
  SOI.splash = (o = {}) => new Promise(resolve => {
    if (still()) return resolve();
    requestAnimationFrame(() => { try { burst(o, resolve); } catch { resolve(); } });
  });

  // underline: a hand-drawn stroke under a label. Wobble is seeded from the text (FNV → LCG) so a word keeps its line
  // across resizes. Px path, no viewBox: the stroke never scales.
  const lines = [];
  let timer;
  function draw(e, animate) {
    const el = e.el, w = el.getBoundingClientRect().width, t = el.textContent || '';
    if (!w || w === e.w) return; // hidden or unchanged
    e.w = w;
    let s = 2166136261, i;
    for (i = 0; i < t.length; i++) { s ^= t.charCodeAt(i); s = Math.imul(s, 16777619); }
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const segs = 3 + (rnd() > .5 ? 1 : 0), pts = [];
    for (i = 0; i <= segs; i++) pts.push([(w / segs) * i + (i && i < segs ? (rnd() - .5) * w * .08 : 0), 5 + (rnd() - .5) * 5]);
    let d = `M${pts[0]}`;
    for (i = 1; i <= segs; i++) d += `Q${(pts[i - 1][0] + pts[i][0]) / 2},${5 + (rnd() - .5) * 8} ${pts[i]}`;
    if (!e.svg) {
      e.svg = svgEl('svg'); e.path = svgEl('path');
      e.svg.setAttribute('class', 'soi-underline-svg'); e.svg.setAttribute('aria-hidden', 'true');
      e.svg.appendChild(e.path); el.appendChild(e.svg);
    }
    e.path.setAttribute('d', d);
    if (e.color) e.path.style.stroke = e.color;
    const len = e.path.getTotalLength();
    e.path.style.strokeDasharray = len; e.path.style.strokeDashoffset = 0;
    if (!animate || !len || still()) return;
    // fill:backwards hides the stroke through the delay; then the inline 0 takes over
    e.path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 600, delay: e.delay, easing: EASE, fill: 'backwards' });
  }
  SOI.underline = (el, { color, delay = 0 } = {}) => {
    try {
      let e = el._soiLine;
      if (!e) lines.push(e = el._soiLine = { el, w: 0 });
      e.color = color; e.delay = delay;
      el.classList.add('soi-underline');
      draw(e, true);
      return e.svg;
    } catch { return null; }
  };
  const redraw = () => { clearTimeout(timer); timer = setTimeout(() => lines.forEach(e => { try { draw(e, false); } catch {} }), 150); };
  function init() {
    try {
      document.querySelectorAll('.soi-underline').forEach((el, i) => { if (!el._soiLine) SOI.underline(el, { delay: i * 90 }); });
      addEventListener('resize', redraw);
      if (document.fonts) document.fonts.ready.then(redraw); // web fonts shift widths
    } catch {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
```

## 4 · Kill-list
 (delete on sight)
**Phrases:** "matching service", "face-processing service", "full-resolution", "watermark-free", "securely", "instantly", "organise", "verification", "memories", "moments", "a little while", "Please try again." as a reflex, "Something went wrong.", "Welcome back —" with an em dash, "Almost there.", "Your next session starts here.", "Backstage access".
**UI patterns:** "01 /" numbered eyebrows · emoji in buttons (📷 ⬆ ✏️ 🔍 🧠 ⚠️ ✓ ✕) · "↗" on every link · "Crew login ↗" in the public footer (just "Crew") · `border-radius: 999px` pills on chips/tabs · pure `#FFFFFF` surfaces without texture · umber-tinted "soft" drop shadows on buttons (use a hard offset instead) · the 3-equal-column "how it works" grid · emoji ★☆ on the cover buttons are fine (they're stamps, not decoration).

