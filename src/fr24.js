// Keeps Flightradar24's adverts from slowing the device down.
//
// On the free site each advert and tracker runs in a frame of its own, and the browser engine
// gives every such frame its own process: measured on the Pi, 17 to 53 processes and more than
// one whole processor core, against 5 processes and about a quarter of a core without them.
// Two things stop that ("fr24BlockAdverts": false in config.json switches both off):
//   1. the advert sites in fr24-blocked.json are made unfindable, as a DNS block would, so
//      their scripts never load. (Refusing the requests instead works equally well, but the
//      site then shows an "ad blocker" notice; with unfindable names it does not.)
//   2. a frame from any other site is refused unless it is one a sign-in can need, which
//      catches advert sites that are not on the list.
// The list is the sites the page was seen to contact; add to it if the log shows processes
// creeping up again.
const BLOCKED = require('./fr24-blocked.json').hosts;
const FRAMES_ALLOWED = ['flightradar24.com', 'fr24.com', 'google.com', 'gstatic.com', 'apple.com', 'recaptcha.net', 'cloudflare.com', 'hcaptcha.com', 'stripe.com', 'paypal.com'];
const within = (host, list) => list.some((entry) => host === entry || host.endsWith(`.${entry}`));

// Before the app is ready: command-line switches can only be set then.
function hideAdvertSites(app) {
  app.commandLine.appendSwitch('host-resolver-rules', BLOCKED.flatMap((host) => [`MAP ${host} ~NOTFOUND`, `MAP *.${host} ~NOTFOUND`]).join(', '));
}

// For the Flightradar24 tab's session.
function refuseOtherFrames(session) {
  session.webRequest.onBeforeRequest((details, done) => {
    let host = '';
    try { host = new URL(details.url).hostname; } catch { /* not a web address */ }
    done({ cancel: details.resourceType === 'subFrame' && Boolean(host) && !within(host, FRAMES_ALLOWED) });
  });
}

// The free site keeps a promotional panel down the right-hand side, which takes two fifths of
// a screen this small ("fr24HidePanel": false in config.json leaves it). The header above the
// map is told about the panel's width separately, so it is stretched back over the full width.
function hidePanel(wc) {
  wc.on('dom-ready', () => wc.insertCSS('aside[data-testid="sidebar__container"] { display: none !important; } .right-sidebar { right: 0 !important; }').catch(() => {}));
}

module.exports = { hideAdvertSites, refuseOtherFrames, hidePanel };
