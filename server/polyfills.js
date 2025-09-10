// polyfills.js
if (typeof DOMMatrix === "undefined") {
  global.DOMMatrix = class {
    constructor() {
      this.a = this.b = this.c = this.d = 1
      this.e = this.f = 0
    }
    // Implement methods as needed
  }
}

if (typeof ImageData === "undefined") {
  global.ImageData = class {
    constructor() {
      // Implement constructor
    }
  }
}

if (typeof Path2D === "undefined") {
  global.Path2D = class {
    constructor() {
      // Implement constructor
    }
  }
}
