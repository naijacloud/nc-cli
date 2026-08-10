# Distribution

How `naijacloud` reaches a user's machine, what each channel needs before its
first release, and what a release actually runs.

Everything except npm ships the **standalone binary** built by
[`scripts/build-binary.mjs`](../scripts/build-binary.mjs), which wraps
`bun build --compile`: the CLI is bundled and embedded into a copy of the Bun
runtime. The result has no dependency on Node being installed — which is what
makes Homebrew, apt, yum, Scoop and WinGet possible at all.

Bun **cross-compiles**, so all five platforms are built on one Linux runner in
about twelve seconds, and Bun's linker ad-hoc signs its own Mach-O output — no
macOS host and no `codesign` step are needed to produce a runnable darwin
binary. Because a cross-compiled artifact cannot be executed on the machine that
produced it, the `smoke` job runs each one on its native runner before the
release proceeds.

---

## Channels

| Channel    | Command                         | Artifact                                | Needs                     |
| ---------- | ------------------------------- | --------------------------------------- | ------------------------- |
| npm        | `npm install -g naijacloud-cli` | `build/` (JS)                           | `NPM_TOKEN`               |
| npx        | `npx naijacloud-cli login`      | same                                    | —                         |
| Homebrew   | `brew install naijacloud`       | `*_darwin_*.tar.gz`, `*_linux_*.tar.gz` | a tap repo                |
| apt        | `apt install naijacloud`        | `.deb`                                  | an apt repo + signing key |
| yum/dnf    | `yum install naijacloud`        | `.rpm`                                  | a yum repo + signing key  |
| Scoop      | `scoop install naijacloud`      | `*_windows_amd64.zip`                   | a bucket repo             |
| ~~WinGet~~ | ~~`winget install NaijaCloud.CLI`~~ | same `.zip` | **disabled** — see below |
| install.sh | `curl … \| sh`                  | the platform's archive                  | nothing                   |

Artifact names are fixed across all of them:

```
naijacloud_<version>_<os>_<arch>.tar.gz    darwin/linux, amd64/arm64
naijacloud_<version>_windows_amd64.zip
naijacloud_<version>_checksums.txt
naijacloud_<version>_<arch>.deb            amd64/arm64
naijacloud-<version>-1.<arch>.rpm          x86_64/aarch64 — nfpm adds the `-1`
                                           release field and the RPM arch names
```

### Two command names

Every channel puts the CLI on the PATH twice: as `naijacloud` and as the short
alias `njc`. There is only ever **one executable** — the alias is a symlink or a
shim, never a second copy, so it costs nothing in a 64 MB binary.

`njc` and not `nc` because `nc` is netcat. On the user-scoped channels that
would merely shadow it; in the `.deb`/`.rpm`, which write to `/usr/bin`, it
would collide head-on with `netcat-openbsd` and `nmap-ncat`, both of which own
that name through `update-alternatives`.

| Channel            | How the alias is created                                       |
| ------------------ | -------------------------------------------------------------- |
| npm / npx          | a second `bin` entry in `package.json`                          |
| tarball            | `njc -> naijacloud` symlink inside the archive, added by [`build-binary.mjs`](../scripts/build-binary.mjs) |
| install.sh         | a second symlink in `~/.local/bin`                              |
| Homebrew           | `bin.install_symlink` in [the formula](templates/homebrew/naijacloud.rb) |
| apt / yum          | a `type: symlink` entry in [`nfpm.yaml`](nfpm.yaml)              |
| Scoop              | a second shim via the `bin` array in [the manifest](templates/scoop/naijacloud.json) |
| WinGet             | a second `PortableCommandAlias` in [the installer manifest](templates/winget/NaijaCloud.CLI.installer.yaml) |

A `.zip` cannot carry a symlink, so on Windows the alias exists only once the
installer has run — which is why the release `smoke` job asserts `njc` on the
tar.gz targets and skips it for `windows_amd64`.

The CLI reads the name it was invoked as ([`src/program-name.ts`](../src/program-name.ts))
and writes its usage, examples and hints in that name, so a `njc` user is never
told to run `naijacloud`. Anything the MCP server shares stays canonical, since
a tool call has no invoked name behind it.

---

## One-time setup

Nothing below is created by the release workflow; each has to exist first.

### Homebrew

**[`Pherwerz/homebrew-tap`](https://github.com/Pherwerz/homebrew-tap)** exists,
with a `Formula/` directory. The workflow commits
[the rendered formula](templates/homebrew/naijacloud.rb) into it on every
release, so `brew install Pherwerz/tap/naijacloud` works, and
`brew install naijacloud` once the tap is tapped. It still needs a `TAP_TOKEN`
secret with write access to that repository, or the step skips.

Homebrew core (plain `brew install naijacloud`, no tap) has its own bar —
notability, a stable release history, no `HEAD`-only versions — and is worth
applying for only after the tap has been live for a while.

### apt and yum

The workflow builds `.deb` and `.rpm` files with
[nfpm](https://nfpm.goreleaser.com/) and attaches them to the release, which
covers `dpkg -i` / `rpm -i`. Repository hosting is a separate decision, because
`apt install naijacloud` needs a signed, indexed repo:

- **Hosted:** Cloudsmith, Packagecloud, or JFrog. Simplest; a token in CI and
  one `push` step per package.
- **Self-hosted:** `aptly` (or `reprepro`) and `createrepo_c` behind a CDN, with
  a GPG key whose public half users import.

Either way, publish the key at a stable URL and document the two-line install in
the README. The packages themselves declare **no dependency on nodejs** — the
binary carries its own runtime.

### Scoop

**[`Pherwerz/scoop-bucket`](https://github.com/Pherwerz/scoop-bucket)** exists,
with a `bucket/` directory. The rendered
[manifest](templates/scoop/naijacloud.json) carries `checkver` and `autoupdate`,
so Scoop's own bots can pick up later releases even if a workflow run is missed.
It shares the `TAP_TOKEN` secret with the Homebrew step.

### WinGet — disabled

The `winget` job is **commented out** in the release workflow, and the
`winget install` line is commented out of the top-level README. Nothing is
published to WinGet today.

The [manifests](templates/winget) are still rendered on every release, so they
stay valid and re-enabling is a matter of uncommenting. To turn it back on:

1. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) onto
   the account that will own the token — `gh repo fork microsoft/winget-pkgs --clone=false`.
2. Create a **classic** PAT with only the `public_repo` scope. Fine-grained
   tokens cannot express what this needs: push to your fork *and* open a pull
   request on a repository you do not own.
3. `gh secret set WINGET_TOKEN`.
4. Uncomment the job — and **pin the action to a tag or SHA rather than
   `@main`**. It receives a classic PAT that can write to every public
   repository on the account, so an unpinned third-party action is a real
   supply-chain exposure.

The first submission is reviewed by a human; later ones are usually automatic.
The package ships as a `zip` with a `portable` nested installer, so there is no
MSI to sign and no elevation prompt.

Note for whoever re-enables this: the manifest lists the same `naijacloud.exe`
twice under different `PortableCommandAlias` values, which is how one portable
package exposes both command names. It is schema-valid and the entries are
distinct, but it has never been through winget-pkgs validation — nothing has
been submitted since the alias was added. Worth checking on that first PR.

### Secrets the workflow reads

| Secret                | Used for                            | Missing means                    |
| --------------------- | ----------------------------------- | -------------------------------- |
| `NPM_TOKEN`           | `npm publish --provenance`          | npm step is skipped              |
| `TAP_TOKEN`           | pushing to the tap and bucket repos | those steps are skipped          |

Steps are conditional on their secret existing, so a first release with none of
them still produces a complete GitHub release.

---

## Code signing

macOS binaries are **ad-hoc signed by Bun's own linker**, on whichever host
built them. That is enough for a binary the user installed themselves via
Homebrew or `install.sh` (Homebrew clears the quarantine attribute, and so does
`install.sh`), but a binary downloaded in a browser will be blocked by
Gatekeeper until it is notarized.

Signing properly with a Developer ID Application identity requires a macOS
runner — `codesign` and `xcrun notarytool` only exist there — so it means adding
a darwin-only job back to the release workflow. Windows binaries are unsigned;
SmartScreen may warn until the download builds reputation, which an EV
certificate would fix.

None of this blocks a first release — it is the difference between a warning and
a smooth install.

---

## Cutting a release

1. Bump `version` in `package.json`, commit.
2. Tag and push: `git tag v0.2.0 && git push --tags`.
3. The [release workflow](../.github/workflows/release.yml) does the rest:
   cross-compiles five binaries on one runner, runs each on its native platform
   to confirm it starts and reports the expected version, generates checksums,
   builds `.deb`/`.rpm`, renders every manifest from the **published** checksums,
   creates the GitHub release, publishes to npm, and updates the tap and the
   bucket. WinGet is not submitted — that job is commented out.

The workflow refuses to run if the tag and `package.json` disagree, and `smoke`
is `fail-fast` on purpose: rendering a formula whose hashes point at artifacts
that were never uploaded — or at one that will not start — is the classic
packaging failure.

### By hand

Requires [Bun](https://bun.sh); every target builds from any machine.

```bash
npm run binary:all                   # all five: dist-bin/naijacloud_<v>_<os>_<arch>[.tar.gz|.zip]
(cd dist-bin && shasum -a 256 *.tar.gz *.zip > naijacloud_<v>_checksums.txt)
npm run packaging -- --checksums dist-bin/naijacloud_<v>_checksums.txt
```

`npm run binary` alone builds just the host platform.

`npm run packaging` writes `dist-packaging/` and fails loudly if any platform's
checksum is missing.

---

## Known gaps

- **Binary size.** 62 MB on darwin_arm64, 82 MB on darwin_amd64, ~104 MB on
  Linux and ~110 MB on Windows; 23–37 MB compressed, which is what a user
  actually downloads. That is the embedded Bun runtime, and it is the price of
  not requiring Node on the target machine. `--minify` saves about 1 MB and
  costs readable stack traces, so it is off. A Go or Rust rewrite is the only
  way substantially below this.
- **`TAP_TOKEN` is not set,** so the Homebrew and Scoop steps both skip even
  though `Pherwerz/homebrew-tap` and `Pherwerz/scoop-bucket` now exist. It needs
  one PAT with write access to both. Their URLs are literals in the workflow.
- **The install script has no host.** The README documents
  `curl -fsSL https://your-domain.example/install.sh | sh`, which is still a
  placeholder. `https://raw.githubusercontent.com/TGod-Ajayi/nc-cli/main/install.sh`
  works today; a real domain is nicer to type and survives a repository rename.
- **No release has been cut yet.** Every URL in the rendered manifests points at
  `releases/download/v<version>`, so the manifests are only valid once a tag has
  produced that release.
