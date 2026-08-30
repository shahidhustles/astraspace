**User:**

Background AI agents are becoming omnipresent in the current era and can play an important role in our digital interactions. If an agentic AI pipeline has access to our visual context, screen states, they can assist users in complex workflows and automate many tasks. Most of the agentic AI pipelines are deployed on server side which limits the type to data that a user can share with it. It would open a new dimension of possibilities, if a local agent is deployed on user machine particularly browser which can eliminate the need to share the sensitive data with the server. Local system generally has fewer resources than server and is unable to host a full-fledged pipeline therefore only the non-sensitive data such as structure of the screen, application fields etc can be sent to server for processing.\
\
Modern browser APIs (such as WebGPU and WebAssembly) and local inference libraries (like ONNX Runtime Web and Transformers.js) have unlocked the ability to run lightweight machine learning models directly on the client. The aim is to bridge these two environments: leveraging the reasoning power of cloud or server based AI while strictly enforcing data privacy at the client side.
\
Description Participants are required to build a privacy-preserving vision agent which runs on browser. This involves implementing a client-side architecture where a local Vision Transformer (ViT) or equivalent computer vision model 'reads' the user's screen and takes decision based on that. If it requires the visual context to be sent to server, it shall sanitize the sensitive/PII data using DOM tags or any other method, before any network request is made. It should dynamically detect and redact sensitive elements. For example, blurring faces, blacking out passwords, and masking PII etc. Only this anonymized, unidentifiable data should be transmitted to the central server which should be aware for this redaction scheme and can process data accordingly. The server will then process the sanitized context and return actionable commands for the browser agent to execute. Participants must balance the trade-offs between inference latency and the accuracy.\
\
Expected Solution A successful submission should include a working prototype consisting of client side extension and server that demonstrates the following:\
\
**Client-side (extension/JS) running in popular browsers (chrome, Firefox) components:**\
\
• Local Vision Processing: Implementation of a client-side vision model running in the browser (e.g., via WebGPU) that evaluates the current screen state.\
• Privacy Preserving Filter: A mechanism for sanitizing sensitive or personal visual data. This can be achieved through local bounding-box redaction, semantic obfuscation, masking etc. This should be clearly demonstrated.\
\
**Server-side implementation components:**\
\
• Server Side Integration: The transmission of the anonymized visual context to a centralized LLM/VLM, which successfully interprets the sanitized data and returns the response which may be processed data to be again ingested by local client or an UI action (e.g., 'click the submit button,' 'scroll down') that the local client executes.\
• Participants are free to use any offline deployable (open-source/open-weights) model on server side. During SIH they can use cloud hosted version of these. An end-to-end task assisting the user should be demonstrated.\
\
**Evaluation will be done on the following metrics:**\
\
1-Accuracy of visual context from screen â€“ 25% 2-Recall and precision for detection of sensitive/PII data â€“ 20% 3-Precision of redaction â€“ 20% 4-Client side resource utilization â€“ 20% 5-Overall end-to-end latency of the provided task -15%



now elts dicuss abotu teh secutiry layer we nneed to ad in the browser mcp itself. hwo do you propose we do that and what all things shoudl we add to fullfill teh requirement and go beyond that. youc an alsorefe rhte break down doc

---

**Assistant:**

The key design decision is this: **do not put the privacy layer only in the cloud MCP server.** The PS explicitly requires sanitization *before any network request*, so the hard privacy boundary has to live inside the extension, with the MCP server acting as a second enforcement layer. 

---

**Assistant:**

I would design this as a **local privacy firewall**, not as “one redaction function.” Every byte leaving the extension—`read_page`, `find`, screenshots, page text, console/network output—must pass through the same egress gate. That matters because the PS is broader than screenshots: it explicitly requires sanitized visual context and sanitized page representation before transmission. 

---

**Assistant:**

Yes. This is exactly the next layer I would build.

Your breakdown already says the privacy engine should locally combine DOM-, text-, and vision-based PII detection, sanitize both screenshots and semantic page representations, and expose the exact redacted context through a privacy inspector. It also notes that **MCP tool-output redaction is still an unsolved future challenge**. I would pull that future challenge forward now and make it part of the browser MCP architecture. fileciteturn7file0

## The architecture I would use

Think of the extension as having a firewall between **anything raw** and **anything networked**:

```text
                      USER'S CHROME
─────────────────────────────────────────────────────────

                    webpage
                       │
              ┌────────┴────────┐
              │                 │
          content.js       chrome.debugger
              │                 │
          raw DOM           raw JPEG
              │                 │
              └────────┬────────┘
                       ▼

                LOCAL PRIVACY ENGINE

          ┌────────────┼────────────┐
          │            │            │
       DOM PII      Text PII    Vision PII
       detector     detector     detector
          │            │            │
          └────────────┼────────────┘
                       ▼
               sensitive regions
                       │
              ┌────────┴────────┐
              │                 │
       semantic redactor    image redactor
              │                 │
              ▼                 ▼
       sanitized DOM      sanitized JPEG
              │                 │
              └────────┬────────┘
                       ▼
                  EGRESS GUARD
                       │
                       │ WSS
───────────────────────┼─────────────────────────────────
                       ▼
                  browser-mcp
                       │
                       ▼
                      Eve
```

The important rule is:

> **`wsSend()` should never be allowed to receive raw browser observations.**

Everything that leaves Chrome goes through one function first.

---

# 1. Build one unified local `PrivacyEngine`

I would add something conceptually like:

```text
chrome-extension/src/privacy/

  dom-detector
  text-detector
  vision-detector

  region-fusion

  semantic-redactor
  image-redactor

  token-vault

  egress-guard
  policy-engine
  privacy-audit
```

Don't make screenshot privacy and DOM privacy two unrelated systems.

They should produce one shared representation:

```ts
SensitiveRegion {
  id: "EMAIL_1"
  type: "EMAIL"
  confidence: 0.99
  source: ["dom", "regex"]
  bbox: [x, y, width, height]
  ref: "ref_42"
}
```

Now every detector contributes to the same result.

---

# 2. Detector 1: DOM PII detection

This should be your cheapest detector and should run first.

Your content script already walks elements and reads:

```text
role
name
placeholder
type
ARIA attributes
text
ref
coordinates
```

So when it sees:

```html
<input
  type="password"
  name="password"
  autocomplete="current-password"
/>
```

you don't need AI.

Immediately mark:

```text
type = PASSWORD
confidence = 1.0
```

Do the same for common sensitive signals:

```text
type=password

autocomplete=
  email
  tel
  cc-number
  cc-csc
  one-time-code
  current-password
  new-password
  street-address

name/id/label/placeholder containing:
  password
  otp
  email
  phone
  mobile
  account
  card
  pan
  aadhaar
  address
  token
  secret
```

And importantly record:

```text
ref_32
+
bounding rectangle
```

You then know both:

> this DOM value must be removed from `read_page`

and:

> this rectangular area must be removed from the JPEG.

One detection gives you both.

---

# 3. Detector 2: local text PII

DOM metadata won't catch:

```text
Contact: john@example.com

Employee ID: 829108

Call me at 98XXXXXXXX
```

because that's ordinary visible text.

So run a cheap local text detector.

I would use two stages.

First:

```text
regex / rules
```

for things with strong structure:

```text
email
phone
card number
IP address
OTP patterns
Indian ID patterns
API keys/tokens
```

Then a very small local NER model for fuzzy entities:

```text
PERSON
ADDRESS
ORGANIZATION, if configured sensitive
LOCATION, if configured sensitive
```

Run that model through ONNX Runtime Web or Transformers.js.

This directly satisfies the breakdown's text-based PII component. fileciteturn7file0

---

# 4. Detector 3: actual local vision

This is necessary because otherwise you're arguably building a DOM privacy filter rather than the **on-device visual perception** system the PS specifically asks for.

The screenshot could contain:

```text
scanned PDF
canvas
image
profile picture
face
text baked into image
remote desktop
chart
document viewer
```

None of that necessarily exists in the DOM.

So:

```text
raw JPEG
   │
   ▼
local vision pipeline
```

should detect at least:

```text
faces
text regions
document/image regions
visually sensitive content
```

OCR then runs over text regions and feeds its output through the **same text PII detector**.

So:

```text
image
 ↓
OCR
 ↓
"john@example.com"
 ↓
EMAIL detector
 ↓
bbox
 ↓
redaction
```

For the SIH prototype I'd run the heavier local model only where necessary:

```text
DOM rules
   ↓

cheap regex
   ↓

OCR / vision when needed
```

rather than running a transformer over the full screenshot every single turn.

That directly helps the 20% resource-utilization and 15% latency categories in the PS. fileciteturn7file0

For an MV3 extension, I'd seriously consider putting the heavier inference runtime in an extension offscreen document rather than keeping it inside your service worker. Chrome provides an MV3 `offscreen` API specifically for creating offscreen extension documents. citeturn470385search0

---

# 5. Merge all detections before redacting

Imagine this page:

```text
Name: Shahid Patel
Email: shahid@example.com

[profile picture]
```

DOM detects:

```text
EMAIL
PERSON
```

Vision detects:

```text
FACE
```

OCR may independently detect:

```text
EMAIL
PERSON
```

Don't redact them independently.

Merge overlapping detections:

```text
DOM EMAIL ─────┐
OCR EMAIL ─────┼── EMAIL_1
NER EMAIL ─────┘
```

Now you get one confident redaction rather than three overlapping boxes.

This also gives you something great for your evaluation slide:

```text
EMAIL_1
confidence: 99.8%

detected by:
DOM + OCR + regex
```

---

# 6. Redact the semantic DOM too

This is the part that is very easy to forget.

Suppose your screenshot is perfectly sanitized.

But `read_page` returns:

```text
textbox "Email"
value="john@example.com"
[ref_32]
```

You've still leaked the email.

Therefore raw browser MCP outputs cannot be sent directly anymore.

Before:

```text
textbox "Email"
value="john@example.com"
[ref_32]
```

After:

```text
textbox "Email"
value=[EMAIL_1]
[ref_32]
```

Password:

```text
textbox "Password"
value=[PASSWORD]
[ref_33]
```

Visible page text:

```text
Welcome John Smith
```

becomes:

```text
Welcome [PERSON_1]
```

Critically, retain useful structure:

```text
role
label
ref
state
bounding box
```

The model still understands the workflow.

It just doesn't know the private value.

That is exactly the idea described in your breakdown's sanitized page representation. fileciteturn7file0

---

# 7. Redact the JPEG locally

Your current path is:

```text
Page.captureScreenshot
       ↓
base64 JPEG
```

Change it to:

```text
Page.captureScreenshot
       ↓
raw JPEG
       ↓
privacy detector
       ↓
redaction boxes
       ↓
local Canvas
       ↓
sanitized JPEG
       ↓
MCP
```

For hard secrets:

```text
PASSWORD
API KEY
CARD
OTP
```

use solid blocking:

```text
██████████████
```

Don't blur them.

Blur can preserve visual information and, depending on content, isn't as strong as completely replacing pixels.

For things where semantic context helps:

```text
email
person
address
```

I would replace the area with something like:

```text
[EMAIL_1]
```

So instead of showing:

```text
john@example.com
```

the model literally sees:

```text
[EMAIL_1]
```

That retains the layout and meaning.

---

# 8. Keep a local token vault

This is where you can go beyond the PS.

Suppose locally you detect:

```text
john@example.com
```

Create:

```text
EMAIL_1
```

and keep locally:

```text
EMAIL_1 -> john@example.com
```

The mapping never goes to the server.

Now the server sees:

```text
textbox "Email"
value=[EMAIL_1]
```

and the screenshot also contains:

```text
[EMAIL_1]
```

Both modalities agree.

This is much better than independently writing `[REDACTED]` everywhere.

You can even do:

```text
PERSON_1
EMAIL_1
PHONE_1
ADDRESS_1
```

throughout the task.

---

# 9. This enables a really strong feature: private actions

Imagine Astra needs to use information that should never go through Eve.

Instead of:

```text
Eve:

form_input(
  ref_12,
  "john@example.com"
)
```

you could eventually support:

```text
form_input_private(
  ref_12,
  handle="EMAIL_1"
)
```

The extension does:

```text
EMAIL_1
   ↓ local vault
john@example.com
   ↓
input field
```

The cloud agent never receives the email.

That is a genuinely good extension of the PS.

The architecture becomes:

```text
Cloud knows:

EMAIL_1


Local extension knows:

EMAIL_1 = john@example.com
```

The cloud reasons with identities.

The extension handles secrets.

---

# 10. Put a hard egress guard before WebSocket

This is probably the single most important implementation detail.

Right now you eventually have:

```js
wsClient.wsSend(...)
```

Do not let code call it directly with browser observations.

Make the architecture:

```text
browser tool result

      ↓

privacyGuard.prepareOutbound()

      ↓

policy validation

      ↓

sanitized result

      ↓

wsSend()
```

Something like conceptually:

```text
RAW_BROWSER_DATA
       │
       ▼
PrivacyGuard
       │
       ├ raw sensitive values present?
       │       └ BLOCK
       │
       ├ raw screenshot?
       │       └ BLOCK
       │
       ├ sanitization failed?
       │       └ BLOCK
       │
       ▼
SANITIZED_DATA
       │
       ▼
WebSocket
```

**Fail closed.**

If the privacy model crashes:

don't say:

```text
privacy failed, send screenshot anyway
```

Say:

```text
image unavailable because local privacy processing failed
```

and let Astra continue using safe DOM information.

That is a strong thing to tell judges.

---

# 11. Don't only protect `read_page` and screenshots

This is where your current MCP tools become important.

You currently have several other ways information can leave the browser.

### `get_page_text`

Huge leak possibility.

Must go:

```text
raw text
 ↓
PII scanner
 ↓
sanitized text
```

### `find`

This might return:

```text
name: "John Smith"
```

Sanitize the element name before sending it.

### `tabs_context_mcp`

A tab could be:

```text
"John Smith - Medical Report"
```

or URL:

```text
site.com/account?email=john@example.com
```

So sanitize:

```text
title
URL query parameters
URL fragments
```

I would normally send:

```text
https://site.com/account
```

not all query parameters.

---

# 12. `read_network_requests` requires special treatment

URLs frequently contain:

```text
?token=...
?email=...
?session=...
?userId=...
```

Headers can contain:

```text
Authorization
Cookie
Set-Cookie
API keys
```

Your agent does not need those.

A safe representation would be:

```text
POST /api/account
status=200
type=fetch
```

instead of:

```text
https://site.com/api/account?token=abc123...
```

Never expose:

```text
Authorization
Cookie
Set-Cookie
request bodies containing credentials
```

through this tool.

---

# 13. Console logs are another leak

Developers frequently accidentally log:

```text
token=...
user=...
email=...
```

So:

```text
read_console_messages
```

also passes through the text PII scanner.

Or for your competition version, simply keep it out of Astra's normal tool set.

It's a debugging feature, not necessary for the browser assistant.

---

# 14. I would disable `javascript_tool` in the production agent

This one is important.

Your normal privacy boundary says:

```text
extension observes
 ↓
privacy guard
 ↓
server
```

But `javascript_tool` lets a cloud model execute arbitrary JavaScript inside the webpage.

That is an enormous privilege.

It could read:

```text
document.body.innerText
local page state
form values
```

and completely bypass the nice `read_page → sanitizer` abstraction.

Worse, arbitrary page JavaScript can initiate network activity itself.

For an SIH privacy-first architecture, I would make:

```text
javascript_tool
```

either:

```text
development build only
```

or:

```text
explicit user-enabled developer mode
```

not part of the ordinary Astra cloud agent.

The same goes for:

```text
debug
debug_timings
set_config
```

They don't need to be general-purpose agent tools.

---

# 15. `file_upload` should also be guarded

Your current tool accepts local filesystem paths.

That's powerful.

For the production privacy agent:

```text
file_upload
```

should require either:

```text
explicit user selection
```

or a previously authorized local file handle.

Don't let the cloud model freely explore arbitrary local paths.

This is not necessary to satisfy the PS, so I'd put it behind permission.

---

# 16. Add an inbound Action Policy Engine

Privacy isn't only about what leaves the browser.

The server sends commands back:

```text
click
type
navigate
upload
```

Before executing:

```text
Eve action
    ↓
MCP
    ↓
extension
```

insert:

```text
ActionPolicy
```

So:

```text
Eve action
    ↓
ActionPolicy
    ↓
allowed?
  ↙       ↘
yes       no
 ↓         ↓
execute    reject
```

Examples:

Routine actions:

```text
scroll
read page
click normal navigation
```

automatic.

More consequential actions:

```text
submit sensitive form
upload local document
change account setting
```

can require user confirmation depending on policy.

This isn't strictly necessary for the PS, but it makes the whole thing feel like a serious privacy/security architecture rather than just screenshot masking.

---

# 17. The cloud browser MCP should have another guard

The first security boundary is local.

But your cloud MCP should assume the extension could contain a bug.

So:

```text
Extension
 ↓ sanitized context
MCP server
 ↓
SERVER DLP CHECK
 ↓
Eve
```

The server can cheaply look for obvious leaks:

```text
emails
tokens
password-like fields
authorization headers
credit-card patterns
```

If something suspicious appears:

```text
reject the observation
```

rather than forward it.

Don't market that as your primary privacy layer.

The raw data has already crossed the network by then.

It's **defense in depth**.

---

# 18. Authenticate extension ↔ MCP properly

This also solves the production issue we discussed earlier.

Don't have:

```text
sessionId = "default"
```

for Web Store users.

Have:

```text
Astra user
   ↓ authentication
browserSessionId
   ↓
short-lived signed token
   ↓
extension WSS connection
```

The MCP router verifies that token and binds:

```text
Eve session
    =
browser session
    =
extension socket
```

Then one user's agent can never reach another user's Chrome.

I would also add:

```text
TLS/WSS
short-lived session tokens
message-size limits
rate limits
request timeouts
random request IDs
```

to that boundary.

---

# 19. Don't log sensitive payloads

This one kills a surprising number of privacy systems.

You can perfectly redact the model input and then accidentally do:

```js
console.log(rawPage)
```

or:

```text
debug log:
form_input value=john@example.com
```

and now it's stored somewhere.

Your privacy logger should log:

```text
read_page
redacted 4 regions
EMAIL x1
PERSON x2
PASSWORD x1

raw values logged: 0
```

Never:

```text
John Smith
john@example.com
hunter2
```

And don't store raw JPEGs in analytics or error reporting.

---

# 20. Make the Privacy Inspector a real enforcement viewer

Your breakdown already has a privacy inspector. fileciteturn7file0

I'd make it one of your strongest demo pieces.

Show three things.

```text
ORIGINAL — LOCAL ONLY

[actual page]
```

beside:

```text
SENT TO ASTRA

Name: [PERSON_1]
Email: [EMAIL_1]
Password: ███████
[face blacked out]
```

and then:

```text
PRIVACY REPORT

4 sensitive regions detected

PERSON       99%
EMAIL        100%
PASSWORD     100%
FACE          98%

Raw sensitive values transmitted: 0

Local privacy latency: 43 ms
Image redaction latency: 8 ms
```

That's very judge-friendly because they can actually see the PS requirement working.

---

# 21. Add a "Privacy Receipt" to every observation

This would go beyond the PS nicely.

Every browser observation gets:

```json
{
  "privacy": {
    "sanitized": true,
    "rawImageTransmitted": false,
    "rawTextTransmitted": false,
    "redactionCount": 5,
    "categories": {
      "PERSON": 1,
      "EMAIL": 1,
      "PASSWORD": 1,
      "FACE": 2
    },
    "localProcessingMs": 48
  }
}
```

Don't send the original values.

Just the proof of what happened.

Now you can accumulate:

```text
Task completed

12 browser observations

47 sensitive regions protected

0 raw sensitive values transmitted

average privacy latency: 41 ms
```

That would be excellent for the demo.

---

# 22. The sanitized observation I'd send to Eve

Instead of separately treating screenshots and DOM, I'd eventually return something conceptually like:

```text
Browser Observation

URL:
https://example.com/account

Page:
heading "Account"

textbox "Full Name"
value=[PERSON_1]
[ref_12]

textbox "Email"
value=[EMAIL_1]
[ref_13]

textbox "Password"
value=[PASSWORD]
[ref_14]

button "Submit"
[ref_15]


Image:
<sanitized JPEG>


Redactions:

PERSON_1
bbox=[120,140,220,28]
source=DOM+NER
confidence=0.99

EMAIL_1
bbox=[120,190,220,28]
source=DOM+regex
confidence=1.00

PASSWORD
bbox=[120,240,220,28]
source=DOM
confidence=1.00
```

Now Eve still has everything it needs to reason.

But identity is gone.

---

# How I would map this directly to the SIH metrics

The problem gives you five categories. fileciteturn7file0

| Evaluation | What we build |
|---|---|
| **Visual context accuracy — 25%** | DOM + local vision + OCR, rather than relying on one representation |
| **PII precision/recall — 20%** | DOM rules + regex + local NER + vision, then detector fusion |
| **Redaction precision — 20%** | Exact DOM bounding boxes + OCR/vision boxes + semantic placeholders |
| **Client resource use — 20%** | DOM-first cascade, quantized local models, WebGPU with fallback, only run expensive detectors when needed |
| **Latency — 15%** | Parallel cheap detectors, cache model, process viewport only, avoid unnecessary vision passes |

So your architecture itself explains why you'll score against every metric.

---

# What I would actually implement first

For the prototype, don't try to make every part equally sophisticated.

Build in this order:

1. **One universal egress guard** before the extension WebSocket.
2. **DOM sensitive-field detector** with bounding boxes.
3. **Regex text PII** for email/phone/IDs/cards/tokens.
4. **Semantic redaction** for `read_page`, `find`, `get_page_text`, tab titles/URLs.
5. **JPEG redaction using DOM bounding boxes.**
6. **Local OCR + face detection** for things the DOM cannot see.
7. **A small local vision model** via WebGPU/WASM for the actual on-device visual-perception requirement.
8. **Privacy Inspector** showing original-local vs sanitized-sent.
9. **Privacy receipts + latency/resource counters.**
10. **Disable/gate bypass tools** such as `javascript_tool`, raw debugging tools and unrestricted file upload.
11. **Server-side DLP + authenticated browser sessions** as defense in depth.
12. **Local placeholder/token vault** if you want a strong beyond-PS feature.

And the principle I would make central to the whole project is:

```text
RAW CONTEXT
     │
     │ never crosses this line
     ▼
┌─────────────────────────┐
│   LOCAL PRIVACY FIREWALL│
└─────────────────────────┘
     │
     ▼
SANITIZED CONTEXT
     │
     ▼
Cloud reasoning
```

That is much stronger than saying “we blur passwords before sending screenshots.” It turns Astra's browser MCP into a **zero-trust data boundary**, where the cloud agent gets enough structure and vision to work but is technically prevented from receiving the original private context. memcite

---

**User:**

give me a map inw hcih amp teh technology emntioend in teh ps itself liek transformer web gpu etc and hwo we are using them.

---

**Assistant:**

Here’s the clean **PS technology → Astra usage map**. I’m keeping the PS terminology intact, then mapping each item to the part of our architecture where it fits. fileciteturn7file0

| PS technology / concept | Where we use it in Astra | What it actually does |
|---|---|---|
| **Chrome / Firefox extension + JS** | Client runtime | Runs the local privacy firewall, captures screen/DOM, executes browser actions, and communicates with Browser MCP |
| **WebGPU** | Local model acceleration | Runs lightweight vision / OCR / PII models on the user's GPU inside the browser |
| **WebAssembly (WASM)** | CPU fallback | Runs the same/local models when WebGPU is unavailable or unsupported |
| **ONNX Runtime Web** | Local inference runtime | Loads quantized ONNX models for OCR, face detection, PII/NER, or lightweight vision inference |
| **Transformers.js** | Local transformer inference | Runs small transformer models directly in-browser, especially text NER/PII or lightweight vision transformer models |
| **Vision Transformer (ViT) or equivalent** | Local visual perception | Looks at the screenshot locally and identifies visual regions the DOM cannot understand |
| **DOM tags / DOM metadata** | First-stage privacy detector | Detects sensitive fields from `type=password`, labels, placeholders, `autocomplete`, ARIA, etc. |
| **Bounding boxes** | Shared privacy representation | Tells Astra exactly which screenshot regions contain private information |
| **OCR** | Visual text extraction | Reads text inside images, PDFs, canvas, scanned docs, etc., then sends that text into local PII detection |
| **Face detection / vision model** | Visual PII detection | Detects faces or other sensitive visual regions that are invisible to DOM inspection |
| **Masking / blacking out / semantic obfuscation** | Local redaction engine | Removes sensitive pixels/text before anything leaves the extension |
| **Sanitized visual context** | Output of privacy firewall | This is the JPEG that Browser MCP sends to Eve instead of the raw screenshot |
| **Sanitized page structure** | Output of DOM privacy layer | `read_page`, `find`, page text, etc. get placeholders like `[EMAIL_1]` instead of raw values |
| **Centralized LLM/VLM** | Eve/cloud reasoning model | Receives only sanitized DOM + sanitized image and decides the next browser action |
| **Open-source/open-weight server model** | Server inference | The PS allows the centralized reasoning model to be an offline-deployable open model; cloud is allowed during SIH |
| **Browser action commands** | Browser MCP | Cloud model returns `click`, `type`, `scroll`, `navigate`, etc. |
| **Client-side execution** | Extension `background.js` | Uses `chrome.debugger`, Chrome APIs, and content script refs to perform the action locally |

## Put together, the full stack becomes

```text
                     USER'S BROWSER
                           │
             ┌─────────────┴─────────────┐
             │                           │
            DOM                      Screenshot
             │                           │
             ▼                           ▼
      DOM metadata detector       Local visual perception
                                      │
                        ┌─────────────┼─────────────┐
                        │             │             │
                       OCR        Face model    ViT/equivalent
                        │             │             │
                        └─────────────┼─────────────┘
                                      │
                                      ▼
                           local PII detection

                  ONNX Runtime Web / Transformers.js
                             │
                    ┌────────┴────────┐
                    │                 │
                 WebGPU             WASM
               fast GPU path       fallback

                             │
                             ▼
                     PRIVACY FIREWALL
                             │
                ┌────────────┴────────────┐
                │                         │
         sanitized DOM              sanitized JPEG
                │                         │
                └────────────┬────────────┘
                             │
                             ▼
                       Browser MCP
                             │
                             ▼
                        Eve / LLM/VLM
                             │
                             ▼
                click / type / scroll / etc.
                             │
                             ▼
                      Chrome extension
                             │
                             ▼
                    chrome.debugger/CDP
```

## The important division of responsibilities

### WebGPU / WASM are **not models**

They are execution backends.

```text
Model
  ↓
ONNX Runtime Web / Transformers.js
  ↓
WebGPU
```

or:

```text
Model
  ↓
ONNX Runtime Web / Transformers.js
  ↓
WASM
```

So don't say:

> “We use WebGPU to detect PII.”

Say:

> “We run lightweight local detection models using ONNX Runtime Web / Transformers.js, accelerated by WebGPU with WASM fallback.”

That's technically much cleaner.

---

## ONNX Runtime Web vs Transformers.js

You probably don't need both for every model.

A sensible split is:

```text
ONNX Runtime Web
    ↓
OCR
face detection
small CV models


Transformers.js
    ↓
NER / text PII
small transformer
ViT-style model if suitable
```

But technically either runtime can overlap depending on which model you choose.

For the presentation, I would simply say:

```text
ONNX Runtime Web + Transformers.js
for local model inference

WebGPU
for GPU acceleration

WASM
as fallback
```

---

## Where the ViT actually fits

This is the part directly tied to the PS.

The PS specifically asks for:

> local Vision Transformer (ViT) or equivalent computer vision model

Your use should be:

```text
Screenshot
   ↓
ViT / lightweight CV model
   ↓
understand visual regions
   ↓
detect areas requiring privacy processing
```

But don't make the ViT responsible for everything.

Your stronger architecture is:

```text
DOM
fast + deterministic

+

OCR / rules
cheap

+

ViT / visual model
for things DOM cannot see
```

This gives you a better latency/resource story than:

```text
every screenshot
   ↓
huge ViT
   ↓
do everything
```

which would hurt the 20% client-resource and 15% latency scores. The breakdown explicitly calls out DOM-first detection, quantized models, WebGPU acceleration, and WASM fallback as the intended optimization direction. fileciteturn7file0

---

## The clean one-line tech mapping for your architecture slide

You could represent it like this:

```text
DOM + OCR + Local ViT
        ↓
ONNX Runtime Web / Transformers.js
        ↓
WebGPU acceleration + WASM fallback
        ↓
Local PII detection & bounding-box redaction
        ↓
Sanitized DOM + JPEG
        ↓
Browser MCP
        ↓
Cloud/Open-weight LLM-VLM
        ↓
Local browser execution
```

That is probably the cleanest way to show that **every technology explicitly mentioned in the PS has a clear role in Astra**, rather than looking like we're name-dropping WebGPU, Transformers.js, ViT, etc. without knowing where they fit.

---

*This file was created with GPTAha Free. [Upgrade to remove this notice →](https://www.gptaha.com/pricing?utm_source=export_watermark)*
