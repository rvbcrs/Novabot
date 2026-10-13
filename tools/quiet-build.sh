# Keep the laptop usable while a release builds.
#
# Source this right after `set -e` in a build script. On macOS it re-runs the
# script in the "utility" QoS class with a lower nice value, so the desktop
# keeps the P-cores and the disk when it needs them, and it caps the tools
# that otherwise start one worker per core. A 16 GB laptop with Docker's 4 GB
# wired swapped itself to a standstill under an EAS build (2026-10-13).
#
#   BUILD_FOREGROUND=1  run at normal priority (e.g. nothing else is open)
#   BUILD_JOBS=N        workers for Gradle, xcodebuild -jobs and vitest (2)
if [[ "$(uname)" == Darwin && -z "${BUILD_FOREGROUND:-}" && -z "${_QUIET_BUILD:-}" ]]; then
  export _QUIET_BUILD=1
  exec taskpolicy -c utility nice -n 10 bash "$0" "$@"
fi
export BUILD_JOBS="${BUILD_JOBS:-2}"
# Gradle reads -D system properties from GRADLE_OPTS as build properties.
export GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.workers.max=${BUILD_JOBS}"
# vitest: threads and forks pools both honour these.
export VITEST_MAX_THREADS="${BUILD_JOBS}" VITEST_MAX_FORKS="${BUILD_JOBS}"
