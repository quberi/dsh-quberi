# dsh-quberi

Search and save to your [Quberi](https://ai.quberi.com) knowledge base from
DeepSeek Harness.

Ask Harness a question about your documents. The first time, your browser
opens by itself so you can approve access; after that the model can call
`quberi_search`, which finds passages in the documents **you** can read in
Quberi, in the one organization you pick. It can also call `quberi_save` to add
a note (a conclusion, decision or summary from the chat) to your knowledge base.
Saving is new in 0.3.0 and needs a fresh approval that includes **save**.

## Install

In DeepSeek Harness open **Plugins → Add plugin** and enter:

```
dsh-quberi
```

Or from a terminal (replace `desktop` with your profile name):

```sh
dsh plugin --profile desktop add dsh-quberi
```

Then restart Harness. To upgrade, remove the old version first
(`dsh plugin --profile desktop remove dsh-quberi`), then add it again.

You need a Quberi account at [ai.quberi.com](https://ai.quberi.com), or your own
Quberi server (see Configuration).

A plugin runs on your machine with your permissions, so read the source first.
It is small: `src/oauth.ts` (sign-in helpers), `src/browser.ts` (opens your
browser), `src/controller.ts` (sign-in, token refresh, search, save) and
`src/index.ts` (the `/quberi` command and the tool). Its only runtime
dependency is `@deepseek-ai/schemastery`.

### From source

```sh
npm install
npm test
npm pack      # builds lib/ and writes dsh-quberi-<version>.tgz
dsh plugin --profile desktop add /path/to/dsh-quberi-<version>.tgz
```

## Use

| Command | What it does |
|---|---|
| `/quberi login` | Opens your browser to sign in to Quberi (the link is also shown in case it does not open). Choose an organization and allow. You rarely need this: the first search does it for you. If you signed in with an older version (read only), run it again to allow saving. |
| `/quberi status` | Shows whether you are connected. Never prints a token. |
| `/quberi logout` | Revokes the sign-in at Quberi and forgets it locally. |

You can also disconnect any time in Quberi under **Account → Connected tools**.

When sign-in finishes, the browser shows a confirmation page and Harness is
brought back to the front (macOS). Nothing needs to be copied or pasted.

On a machine with no screen (a remote shell), the browser is not opened; the
plugin gives you the link to open on another device instead.

## Before it works

The organization you choose must allow outside tools. It is **off by default**.
An owner or admin turns it on under **Admin console → Integrations → Outside
tools**; owners and admins also get a "Turn on" button on the approval page.

## What leaves Quberi

The passages the search returns go to Harness and to whichever AI model Harness
uses. Quberi's "check before sending" step does not apply to this path. Every
search is recorded in the organization's audit log (the tool's name and the
documents returned, never the question or the text).

## Saving notes

`quberi_save` takes a title, the note text (Markdown) and, optionally, the name
of a space. With no space it saves into **your personal space**. The tool asks
the model to offer to save and wait for you to agree, not to save silently, but
that is an instruction to the model, not a guarantee: you decide by what you
approve and by watching what the model does.

A saved note becomes a document in that space. **Anyone who can read that space
can find it**, so name a shared space only on purpose. Saving is recorded in
the audit log (the tool's name and the new document, not the text).

## What it can and cannot do

- It acts as you: search only reads spaces you can read, and save only writes
  into spaces you can edit. Both are re-checked on every call. If your access
  changes, the next call reflects it.
- It can add notes, nothing else. It cannot edit or delete anything that is
  already there, and it cannot upload files.
- Saving is a separate permission (`knowledge:write`). A sign-in made by an
  earlier version only allows search; it is not upgraded behind your back.
- Access tokens last one hour and refresh on their own; a sign-in lasts at most
  90 days. A refresh token that is used twice is treated as stolen and the whole
  sign-in is revoked.
- Turning outside tools off for the organization, or disconnecting in Quberi,
  stops the very next search or save.

## Configuration

Defaults are right for the hosted service. For a self-hosted Quberi, point
`baseUrl` at your API (https, or `http://127.0.0.1:<port>` for development).
`openBrowser`, `autoLogin` and `focusApp` (all on by default) switch off the
automatic browser, sign-in on first use, and returning to Harness:

```yaml
- insert:
    - id: quberi
      name: dsh-quberi
      config:
        baseUrl: https://api.example.com
        # openBrowser: false
        # autoLogin: false
        # focusApp: false
```

## Compatibility

Built and tested against `@deepseek-ai/*` `0.2.0-rc.2`. Harness is a developer
preview and its plugin interfaces can change. The token set is stored with the
credential-record API (`credentials.modifyRecord`) so two Harness processes
cannot overwrite each other's rotated refresh token.

## License

MIT. See [LICENSE](./LICENSE).
