// Must run before Prism loads: stops it from scanning the page and highlighting on its own.
(globalThis as { Prism?: unknown }).Prism = { manual: true };
