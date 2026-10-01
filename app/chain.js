//each log and audit entry keeps the hash of the previous one, so editing an entry breaks the chain
import crypto from "crypto";

export function linkHash(prev, entry) {
  return crypto.createHash("sha1").update(prev + JSON.stringify(entry)).digest("hex");
}

//index of the first entry that does not match its hash, -1 if none
export function brokenAt(entries) {
  let last = "";

  for (let i = 0; i < entries.length; i++) {
    const { prev, hash, ...entry } = entries[i];

    if (prev !== last || hash !== linkHash(prev, entry)) {
      return i;
    }

    last = hash;
  }

  return -1;
}
