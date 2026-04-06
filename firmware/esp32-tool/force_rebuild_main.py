Import("env")
# Touch main.cpp before each build so __DATE__ / __TIME__ are always fresh
import pathlib, time
main = pathlib.Path("src/main.cpp")
if main.exists():
    main.touch()
