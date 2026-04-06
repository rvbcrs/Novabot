 
#!/bin/bash
DATE=`date +%Y%m%d_%H%M%S`
dd if=/dev/zero of=/root/novabot/test_disk_$DATE.zip bs=2G count=1
