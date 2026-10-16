/*
 * Linux exclusive-lock helper.
 *
 * The signer does not compile this file. The executable shipped beside it,
 * flock-linux-x64, is sha256-pinned. The signer hashes one open descriptor
 * and execs that same descriptor. Rebuilds must use
 * docker/flock-helper.Dockerfile and replace the binary and the digest in
 * src/signer/flock.ts together.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 1;
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) return 1;
  if (getppid() == 1) return 1;
  umask(077);
  int fd = open(argv[1], O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
  if (fd < 0) return 1;
  if (fchmod(fd, 0600) != 0) return 1;
  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    return (errno == EWOULDBLOCK || errno == EAGAIN) ? 2 : 1;
  }
  if (write(STDOUT_FILENO, "ok\n", 3) != 3) return 1;
  for (;;) pause();
  return 0;
}
