# Link Keeper — Android share target

Three Java files, zero dependencies, zero resources: the share sheet gains a **Link Keeper**
entry that POSTs the shared URL to the inbox receiver (`../receiver/`) and gets out of the way.
Offline or Tailscale down? The link waits in a local queue and rides along with the next share,
or a manual *Flush queue*.

Build and install (bare SDK tools, no Gradle):

    ./build.zsh --install

Configure once — either in the app (endpoint + token), or over adb without typing:

    adb shell am start -n keeper.link.share/.MainActivity \
        -e endpoint http://<tailscale-ip>:8477 -e token <token>

The endpoint should be the receiver's Tailscale address, so nothing here ever crosses the open
internet, and the phone needs its Tailscale on (or the queue holds until it is).
