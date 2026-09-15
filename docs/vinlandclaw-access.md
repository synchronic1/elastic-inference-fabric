# VinlandClaw remote access + Carlssons share

How to reach **VinlandClaw** (VM101) over SSH from anywhere, and how to get at
the **Carlssons CIFS share** through it. VinlandClaw is physically in Sweden;
there is no LAN path to it from outside that network, so all access is tunneled.

## The box

| | |
|---|---|
| Role | OpenClaw agent host; also runs the self-hosted **Plane** app and Mixpost |
| Hostname | `ubuntu-desktop` (Ubuntu 24.04 LTS, KVM/QEMU guest) |
| LAN IP | `192.168.1.204` (Sweden / Vinlandsgatan network) |
| Public IP | `90.225.100.48` |
| Login user | `rm` (uid/gid 1000, `NOPASSWD` sudo) |

## How `ssh vinlandclaw` works

There is **no inbound port open** on the Swedish connection. SSH rides the
existing Cloudflare tunnel that already serves `plane.heurchain.com`:

```
ssh client → cloudflared access ssh → Cloudflare edge
           → tunnel plane-heurchain (d2d3ec82-64f7-4263-a8fe-b0a221fcd158)
           → cloudflared on the box → localhost:22 (sshd, key-only)
```

- Tunnel ingress: `ssh.heurchain.com → ssh://localhost:22` (added to the
  `plane-heurchain` tunnel; it also carries `plane.heurchain.com` and
  `mixpost.heurchain.com`).
- DNS: `ssh.heurchain.com` is a **proxied** CNAME to
  `d2d3ec82-64f7-4263-a8fe-b0a221fcd158.cfargotunnel.com`
  (zone `heurchain.com` = `a5b93a216b51f741d2379116542d830b`).
- Auth: **public key only** — password auth is disabled on the box
  (`/etc/ssh/sshd_config.d/00-disable-password-auth.conf`).

Because it is a proxied hostname, a bare `ssh ssh.heurchain.com` will **time
out** (port 22 at Cloudflare's edge speaks HTTP, not SSH). You must go through
`cloudflared access ssh`, which the SSH config block below wires up
automatically.

## Client setup (do this once on each machine that needs access)

1. Install `cloudflared` (`brew install cloudflared`, or the Cloudflare apt repo
   on Linux).
2. Install the private key whose public half is authorized on the box:
   ```
   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPR23YKMd52eJ1We9JuTaYPy/0Fq1oEyDMr43MU9Xsk4 openclaw-mcp-access
   ```
   (Key `id_ed25519_cluster`; fingerprint `SHA256:02LErzCVHu/DrvkyOTdwG8ks2oFqlbhfZQL5McgiOrY`.)
   To authorize a new key, append its public line to `/home/rm/.ssh/authorized_keys`
   on the box.
3. Add to `~/.ssh/config` (adjust the `cloudflared` path on Linux):
   ```
   Host vinlandclaw sweden ssh.heurchain.com
       HostName ssh.heurchain.com
       User rm
       IdentityFile ~/.ssh/id_ed25519_cluster
       ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h
       ServerAliveInterval 30
       ServerAliveCountMax 6
   ```

Then:

```sh
ssh vinlandclaw
```

## The Carlssons share

A CIFS/SMB share is mounted on the box and exposed to SSH clients.

- **Mount point:** `/mnt/carlssons` (CIFS, SMB 3.1.1). Backed by the host disk
  (`/mnt/pve-storage`).
- **fstab options:** `nofail,_netdev,soft,x-systemd.automount` — systemd
  automounts it on first access and idles it out after ~120s. Boot never hangs
  if the storage host is down, and it self-recovers when it returns.
- **Ownership mapping:** all files map to `rm` (uid/gid 1000), `0664` files /
  `0775` dirs.
- **Login shortcut:** `~/carlssons` is a symlink to `/mnt/carlssons`, so anyone
  landing in `/home/rm` over SFTP/SCP sees the share immediately — no need to
  know the `/mnt` path. sshd has no `ChrootDirectory`, so the symlink is
  followed normally.

### Reaching the share

All of these go through the same tunnel, so they work from any configured client:

```sh
# interactive shell, then cd into the share
ssh vinlandclaw
rm@ubuntu-desktop:~$ cd carlssons

# interactive SFTP (lands in /home/rm; the share is ./carlssons)
sftp vinlandclaw

# copy a file up into the share
scp ./report.pdf vinlandclaw:carlssons/

# copy a file down from the share
scp vinlandclaw:carlssons/notes.txt .

# mirror a directory up
rsync -avz ./localdir/ vinlandclaw:carlssons/localdir/
```

Round-trip has been verified end to end: an SFTP upload appears on the host's
real disk at `/mnt/pve-storage/`, on any other machine that mounts the same
share, and downloads back byte-identical over `scp` — one set of files on one
SSD, three views.

## RDP (desktop) access

xrdp is installed and bound to **localhost only** (`127.0.0.1:3389`). Reach it
by forwarding the port over the same SSH connection, then point an RDP client at
`localhost:3389` and log in as `rm`:

```sh
ssh -L 3389:localhost:3389 vinlandclaw   # leave running
# RDP client → localhost:3389, user rm
```

Do not log into the box's physical console as `rm` while using RDP — GNOME will
not run the same user in two seats.

## Caveats / known issues

- **Memory is tight.** The VM has ~12 GB, no ballooning, and no hot-add
  headroom. Any in-container Django management command on Plane (`manage.py`
  shell/migrate) will **OOM-kill** that container. Raising RAM needs a
  host-side `qm set --memory` + VM reboot on the Proxmox host
  (`192.168.1.210`); that work is blocked pending a valid Proxmox credential
  (`root@pam` password tried so far were rejected) and a stable path to the host.
- **The Sweden LAN flaps.** Reachability from the box to LAN peers
  (including the Proxmox host `192.168.1.210`) swings between fully up and fully
  down within minutes, while the box's own internet/tunnel stays up. This is an
  L2 fault (switch port / cable / NIC), not fixable from the guest. The share's
  `soft`/automount options are what keep it resilient to this. If the share
  ever shows stale/hung, `ls ~/carlssons` re-triggers the automount.
- **Occasional 502s** on `plane.heurchain.com` and, by extension, brief SSH
  connect hiccups trace to the same tunnel/LAN instability; retry.
