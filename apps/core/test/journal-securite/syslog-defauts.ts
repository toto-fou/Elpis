// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/syslog-defauts.ts — fichiers rsyslog installés par défaut (Debian 12, Ubuntu 24.04, RHEL 9), pour les tests de détection de la règle. */

/** /etc/rsyslog.conf de Debian 12. */
export const DEBIAN_12 = `# /etc/rsyslog.conf configuration file for rsyslog
#
# For more information install rsyslog-doc and see
# /usr/share/doc/rsyslog-doc/html/configuration/index.html


#################
#### MODULES ####
#################

module(load="imuxsock") # provides support for local system logging
module(load="imklog")   # provides kernel logging support
#module(load="immark")  # provides --MARK-- message capability

# provides UDP syslog reception
#module(load="imudp")
#input(type="imudp" port="514")

# provides TCP syslog reception
#module(load="imtcp")
#input(type="imtcp" port="514")


###########################
#### GLOBAL DIRECTIVES ####
###########################

#
# Set the default permissions for all log files.
#
$FileOwner root
$FileGroup adm
$FileCreateMode 0640
$DirCreateMode 0755
$Umask 0022

#
# Where to place spool and state files
#
$WorkDirectory /var/spool/rsyslog

#
# Include all config files in /etc/rsyslog.d/
#
$IncludeConfig /etc/rsyslog.d/*.conf


###############
#### RULES ####
###############

#
# Log anything besides private authentication messages to a single log file
#
*.*;auth,authpriv.none		-/var/log/syslog

#
# Log commonly used facilities to their own log file
#
auth,authpriv.*			/var/log/auth.log
cron.*				-/var/log/cron.log
kern.*				-/var/log/kern.log
mail.*				-/var/log/mail.log
user.*				-/var/log/user.log

#
# Emergencies are sent to everybody logged in.
#
*.emerg				:omusrmsg:*
`;

/** /etc/rsyslog.conf d'Ubuntu 24.04. */
export const UBUNTU_24_04 = `# /etc/rsyslog.conf configuration file for rsyslog
#
# For more information install rsyslog-doc and see
# /usr/share/doc/rsyslog-doc/html/configuration/index.html
#
# Default logging rules can be found in /etc/rsyslog.d/50-default.conf


#################
#### MODULES ####
#################

module(load="imuxsock") # provides support for local system logging
#module(load="immark")  # provides --MARK-- message capability

# provides UDP syslog reception
#module(load="imudp")
#input(type="imudp" port="514")

# provides TCP syslog reception
#module(load="imtcp")
#input(type="imtcp" port="514")

# provides kernel logging support and enable non-kernel klog messages
module(load="imklog" permitnonkernelfacility="on")

###########################
#### GLOBAL DIRECTIVES ####
###########################

# Filter duplicated messages
$RepeatedMsgReduction on

#
# Set the default permissions for all log files.
#
$FileOwner syslog
$FileGroup adm
$FileCreateMode 0640
$DirCreateMode 0755
$Umask 0022
$PrivDropToUser syslog
$PrivDropToGroup syslog

#
# Where to place spool and state files
#
$WorkDirectory /var/spool/rsyslog

#
# Include all config files in /etc/rsyslog.d/
#
$IncludeConfig /etc/rsyslog.d/*.conf
`;

/** /etc/rsyslog.d/50-default.conf d'Ubuntu 24.04. */
export const UBUNTU_24_04_50_DEFAULT = `#  Default rules for rsyslog.
#
#			For more information see rsyslog.conf(5) and /etc/rsyslog.conf

#
# First some standard log files.  Log by facility.
#
auth,authpriv.*			/var/log/auth.log
*.*;auth,authpriv.none		-/var/log/syslog
#cron.*				/var/log/cron.log
#daemon.*			-/var/log/daemon.log
kern.*				-/var/log/kern.log
#lpr.*				-/var/log/lpr.log
mail.*				-/var/log/mail.log
#user.*				-/var/log/user.log

#
# Logging for the mail system.  Split it up so that
# it is easy to write scripts to parse these files.
#
#mail.info			-/var/log/mail.info
#mail.warn			-/var/log/mail.warn
mail.err			/var/log/mail.err

#
# Some "catch-all" log files.
#
#*.=debug;\\
#	auth,authpriv.none;\\
#	news.none;mail.none	-/var/log/debug
#*.=info;*.=notice;*.=warn;\\
#	auth,authpriv.none;\\
#	cron,daemon.none;\\
#	mail,news.none		-/var/log/messages

#
# Emergencies are sent to everybody logged in.
#
*.emerg				:omusrmsg:*

#
# I like to have messages displayed on the console, but only on a virtual
# console I usually leave idle.
#
#daemon,mail.*;\\
#	news.=crit;news.=err;news.=notice;\\
#	*.=debug;*.=info;\\
#	*.=notice;*.=warn	/dev/tty8
`;

/** /etc/rsyslog.d/20-ufw.conf d'Ubuntu 24.04 (paquet ufw). */
export const UBUNTU_24_04_20_UFW = `# Log kernel generated UFW log messages to file
:msg,contains,"[UFW " /var/log/ufw.log

# Uncomment the following to stop logging anything that matches the last rule.
# Doing this will stop logging kernel generated UFW log messages to the file
# normally containing kern.* messages (eg, /var/log/kern.log)
#& stop
`;

/** /etc/rsyslog.d/21-cloudinit.conf d'Ubuntu 24.04 (images cloud). */
export const UBUNTU_24_04_21_CLOUDINIT = `# Log cloudinit generated log messages to file
:syslogtag, isequal, "[CLOUDINIT]" /var/log/cloud-init.log

# comment out the following line to allow CLOUDINIT messages through.
# Doing so means you'll also get CLOUDINIT messages in /var/log/syslog
& stop
`;

/** /etc/rsyslog.conf de RHEL 9. */
export const RHEL_9 = `# rsyslog configuration file

# For more information see /usr/share/doc/rsyslog-*/rsyslog_conf.html
# If you experience problems, see http://www.rsyslog.com/doc/troubleshoot.html

#### GLOBAL DIRECTIVES ####
global(workDirectory="/var/lib/rsyslog")
module(load="builtin:omfile" Template="RSYSLOG_TraditionalFileFormat")

#### MODULES ####

module(load="imuxsock" 	  # provides support for local system logging (e.g. via logger command)
       SysSock.Use="off") # Turn off message reception via local log socket;
			  # local messages are retrieved through imjournal now.
module(load="imjournal"             # provides access to the systemd journal
       UsePid="system" # PID nummber is retrieved as the ID of the process the journal entry originates from
       FileCreateMode="0644" # Set the access permissions for the state file
       StateFile="imjournal.state") # File to store the position in the journal
#module(load="imklog") # reads kernel messages (the same are read from journald)

# Include all config files in /etc/rsyslog.d/
include(file="/etc/rsyslog.d/*.conf" mode="optional")

#### RULES ####
#kern.*                                                 /dev/console
# Don't log private authentication messages!
*.info;mail.none;authpriv.none;cron.none                /var/log/messages
authpriv.*                                              /var/log/secure
mail.*                                                  -/var/log/maillog
cron.*                                                  /var/log/cron
*.emerg                                                 :omusrmsg:*
uucp,news.crit                                          /var/log/spooler
local7.*                                                /var/log/boot.log

# ### sample forwarding rule ###
#action(type="omfwd"  
# # An on-disk queue is created for this action. If the remote host is
#queue.filename="fwdRule1"       # unique name prefix for spool files
#Target="remote_host" Port="XXX" Protocol="tcp")
`;
