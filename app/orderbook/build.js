// builds orderbook.html: page.html with superscalp.js inlined (one self-contained file)
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "superscalp.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const page = fs.readFileSync(path.join(__dirname, "page.html"), "utf8");
if (!page.includes("/*__SUPERSCALP__*/")) throw new Error("marker missing");
fs.writeFileSync(path.join(__dirname, "..", "orderbook.html"), page.replace("/*__SUPERSCALP__*/", () => src));
console.log("orderbook.html built");
