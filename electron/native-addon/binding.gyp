{
  "targets": [
    {
      "target_name": "cs2_window_tracker",
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "sources": [
        "src/cs2_window_tracker.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS=='win'", {
          "defines": [ "_WINDOWS" ],
          "libraries": [
            "-luser32",
            "-lkernel32",
            "-lpsapi"
          ]
        }]
      ]
    }
  ]
}
